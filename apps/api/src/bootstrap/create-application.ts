/** Build the HTTP application independently of opening a network listener for testability. */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  DocumentBuilder,
  SwaggerModule,
  getSchemaPath,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { HttpErrorResponseDto } from '../shared/http/http-error-response.dto.js';
import { assignRequestId } from '../shared/http/request-id.js';
import { ApiModule } from './api.module.js';

/** Document request correlation on all operations and the shared envelope on errors without replacing successful contracts. */
function configureHttpDocumentation(document: OpenAPIObject): void {
  for (const path of Object.values(document.paths)) {
    for (const method of [
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'head',
      'options',
    ] as const) {
      const operation = path[method];
      if (!operation) {
        continue;
      }
      operation.parameters = [
        ...(operation.parameters ?? []),
        {
          in: 'header',
          name: 'X-Request-Id',
          required: false,
          description:
            'Optional diagnostic reference: 1–128 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit. Invalid values are replaced. Never an authorization or idempotency key.',
          schema: { type: 'string', maxLength: 128 },
        },
      ];
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response === undefined || '$ref' in response) {
          continue;
        }
        response.headers = {
          ...response.headers,
          'X-Request-Id': {
            description:
              'Validated caller diagnostic reference, or a server-generated UUID.',
            schema: { type: 'string' },
          },
        };
        if (Number(status) >= 400 && /^\d{3}$/.test(status)) {
          response.content = {
            'application/json': {
              schema: { $ref: getSchemaPath(HttpErrorResponseDto) },
            },
          };
        }
      }
    }
  }
}

/** Add development API documentation; production exposes no interactive documentation route. */
function configureDocumentation(application: NestFastifyApplication): void {
  const configuration = application.get(ConfigService);
  if (configuration.getOrThrow<string>('NODE_ENV') === 'production') {
    return;
  }
  const options = new DocumentBuilder()
    .setTitle('AxiaPay API')
    .setDescription('Individual payment application API foundation.')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'opaque' })
    .addGlobalResponse({
      status: 500,
      description:
        'Unexpected server error; this response does not confirm a financial outcome.',
    })
    .build();
  const document = SwaggerModule.createDocument(application, options, {
    extraModels: [HttpErrorResponseDto],
  });
  configureHttpDocumentation(document);
  SwaggerModule.setup('docs', application, document);
}

/** Compose the API with redacted logging, versioned routes, and graceful shutdown hooks. */
export async function createApplication(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    requestIdHeader: false,
    genReqId: assignRequestId,
  });
  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-Id', request.id);
    done();
  });
  const application = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    adapter,
    { bufferLogs: true, abortOnError: false, rawBody: true },
  );
  application.useLogger(application.get(Logger));
  application.setGlobalPrefix('v1', {
    exclude: [{ path: 'health/live', method: RequestMethod.GET }],
  });
  application.enableShutdownHooks();
  configureDocumentation(application);
  return application;
}
