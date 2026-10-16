/** Start the separately deployable background process without creating an HTTP listener. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

/** Start durable recovery and drain its handlers before closing shared resources on SIGINT or SIGTERM. */
async function bootstrap(): Promise<void> {
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  application.useLogger(application.get(Logger));
  application.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  application.get(Logger).log({ event: 'worker_started' });
}

await bootstrap();
