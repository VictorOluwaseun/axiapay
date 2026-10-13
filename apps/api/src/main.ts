/** Start the API process using validated host and port settings. */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createApplication } from './bootstrap/create-application.js';

/** Open the HTTP listener after application composition and configuration validation succeed. */
async function bootstrap(): Promise<void> {
  const application = await createApplication();
  const configuration = application.get(ConfigService);
  await application.listen(
    configuration.getOrThrow<number>('PORT'),
    configuration.getOrThrow<string>('HOST'),
  );
}

await bootstrap();
