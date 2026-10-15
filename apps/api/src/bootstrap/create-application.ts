/** Build the HTTP application independently of opening a network listener for testability. */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
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
import { ApiModule } from './api.module.js';

/** Assign one server-generated identity to Fastify and its raw request so Pino and public error responses correlate. */
function assignRequestId(
  request: IncomingMessage | Http2ServerRequest,
): string {
  const requestId = randomUUID();
  Object.assign(request, { id: requestId });
  return requestId;
}

/** Document the shared envelope for every declared error without replacing feature descriptions or successful contracts. */
function configureErrorDocumentation(document: OpenAPIObject): void {
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
      for (const [status, response] of Object.entries(operation.responses)) {
        if (
          response === undefined ||
          Number(status) < 400 ||
          !/^\d{3}$/.test(status) ||
          '$ref' in response
        ) {
          continue;
        }
        response.content = {
          'application/json': {
            schema: { $ref: getSchemaPath(HttpErrorResponseDto) },
          },
        };
        response.headers = {
          ...response.headers,
          'X-Request-Id': {
            description: 'Server-generated diagnostic reference.',
            schema: { type: 'string' },
          },
        };
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
  configureErrorDocumentation(document);
  SwaggerModule.setup('docs', application, document);
}

/** Compose the API with redacted logging, versioned routes, and graceful shutdown hooks. */
export async function createApplication(): Promise<NestFastifyApplication> {
  const application = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    new FastifyAdapter({ requestIdHeader: false, genReqId: assignRequestId }),
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
