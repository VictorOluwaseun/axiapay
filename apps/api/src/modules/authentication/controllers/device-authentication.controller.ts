import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DeviceAuthenticationService } from '../services/device-authentication.service.js';
import { AuthenticationGuard } from '../guards/authentication.guard.js';
import { AuthenticationExceptionFilter } from '../filters/authentication-exception.filter.js';
import { AuthenticationCacheInterceptor } from '../interceptors/authentication-cache.interceptor.js';
import {
  readBearerToken,
  type AuthenticationHttpRequest,
} from '../types/authentication-http.js';
import {
  EnrollDeviceDto,
  DeviceIdentifierDto,
  DeviceProofDto,
  DeviceChallengeResponseDto,
  DeviceResponseDto,
} from '../dtos/device-authentication.dto.js';
import { AuthenticationResponseDto } from '../dtos/authentication-response.dto.js';

/** Map biometric-device HTTP contracts to workflows; proof validation, ownership, and session policy belong in services. */
@ApiTags('device authentication')
@ApiResponse({
  status: 400,
  description: 'Invalid input or unsupported public key.',
})
@ApiResponse({ status: 401, description: 'Invalid session, device, or proof.' })
@ApiResponse({
  status: 403,
  description:
    'Recent password or one-time-code authentication required for enrollment.',
})
@ApiResponse({
  status: 409,
  description: 'Device limit reached or key already registered.',
})
@ApiResponse({
  status: 429,
  description: 'Attempt budget exhausted; observe Retry-After.',
})
@ApiResponse({
  status: 503,
  description: 'Authentication storage unavailable.',
})
@UseFilters(AuthenticationExceptionFilter)
@UseInterceptors(AuthenticationCacheInterceptor)
@Controller('auth')
export class DeviceAuthenticationController {
  /** Receive the workflow service, keeping storage and cryptography out of transport adapters. */
  constructor(
    @Inject(DeviceAuthenticationService)
    private readonly devices: DeviceAuthenticationService,
  ) {}

  /** Begin opt-in enrollment after fresh primary authentication. */
  @Post('devices/enrollment/challenge')
  @HttpCode(200)
  @UseGuards(AuthenticationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Request device enrollment proof' })
  @ApiResponse({ status: 200, type: DeviceChallengeResponseDto })
  enroll(
    @Body() body: EnrollDeviceDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.devices.requestEnrollment(
      readBearerToken(request.headers.authorization),
      { ...body, clientIp: request.ip },
    );
  }
  /** Activate a key only after its signature and initiating primary session are both verified. */
  @Post('devices/enrollment/verify')
  @HttpCode(201)
  @UseGuards(AuthenticationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Complete device enrollment' })
  @ApiResponse({ status: 201, type: DeviceResponseDto })
  verifyEnrollment(
    @Body() body: DeviceProofDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.devices.verifyEnrollment(
      readBearerToken(request.headers.authorization),
      { ...body, clientIp: request.ip },
    );
  }
  /** Issue an opaque login challenge without exposing device-registration status. */
  @Post('login/device/challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a device login challenge' })
  @ApiResponse({ status: 200, type: DeviceChallengeResponseDto })
  challenge(
    @Body() body: DeviceIdentifierDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.devices.requestLogin({ ...body, clientIp: request.ip });
  }
  /** Exchange one valid device signature for the existing opaque bearer-session response. */
  @Post('login/device/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify device proof and issue a session' })
  @ApiResponse({ status: 200, type: AuthenticationResponseDto })
  login(
    @Body() body: DeviceProofDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.devices.verifyLogin({ ...body, clientIp: request.ip });
  }
  /** List active device credentials belonging to the authenticated account. */
  @Get('devices')
  @UseGuards(AuthenticationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List registered devices' })
  @ApiResponse({ status: 200, type: DeviceResponseDto, isArray: true })
  list(@Req() request: AuthenticationHttpRequest) {
    return this.devices.list(readBearerToken(request.headers.authorization));
  }
  /** Revoke an owned credential and its device-issued sessions; ownership is rechecked by the service. */
  @Delete('devices/:credentialId')
  @HttpCode(204)
  @UseGuards(AuthenticationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a registered device' })
  @ApiResponse({
    status: 204,
    description: 'Device removed or no owned registration matches.',
  })
  revoke(
    @Param() parameters: DeviceIdentifierDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.devices.revoke(
      readBearerToken(request.headers.authorization),
      parameters.credentialId,
    );
  }
}
