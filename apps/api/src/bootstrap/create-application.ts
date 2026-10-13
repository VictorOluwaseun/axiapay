/** Build the HTTP application independently of opening a network listener for testability. */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { ApiModule } from './api.module.js';

/** Add development API documentation; production exposes no interactive documentation route. */
function configureDocumentation(application: NestFastifyApplication): void {
  const configuration = application.get(ConfigService);
  if (configuration.getOrThrow<string>('NODE_ENV') === 'production') return;
  const options = new DocumentBuilder()
    .setTitle('AxiaPay API')
    .setDescription('Individual payment application API foundation.')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'opaque' })
    .build();
  const document = SwaggerModule.createDocument(application, options);
  SwaggerModule.setup('docs', application, document);
}

/** Compose the API with redacted logging, versioned routes, and graceful shutdown hooks. */
export async function createApplication(): Promise<NestFastifyApplication> {
  const application = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    new FastifyAdapter(),
    { bufferLogs: true, abortOnError: false },
  );
  application.useLogger(application.get(Logger));
  application.setGlobalPrefix('v1', {
    exclude: [{ path: 'health/live', method: RequestMethod.GET }],
  });
  application.enableShutdownHooks();
  configureDocumentation(application);
  return application;
}
