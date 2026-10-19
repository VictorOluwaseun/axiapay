import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Ip,
  Post,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticationService } from '../services/authentication.service.js';
import { AuthenticationGuard } from '../guards/authentication.guard.js';
import { AuthenticationCacheInterceptor } from '../interceptors/authentication-cache.interceptor.js';
import { AuthenticationExceptionFilter } from '../filters/authentication-exception.filter.js';
import type { AuthenticationHttpRequest } from '../types/authentication-http.js';
import { BearerToken } from '../decorators/bearer-token.decorator.js';
import {
  SignupDto,
  VerifyCodeDto,
  PasswordLoginDto,
  RequestLoginCodeDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
  RefreshSessionDto,
} from '../dtos/authentication-request.dto.js';
import {
  CodeChallengeResponseDto,
  AuthenticationResponseDto,
  AccountIdentityResponseDto,
} from '../dtos/authentication-response.dto.js';

/** Map validated HTTP input to the feature service; no authentication or persistence policy belongs in this controller. */
@ApiTags('authentication')
@ApiResponse({ status: 400, description: 'Invalid request shape or contact.' })
@ApiResponse({
  status: 401,
  description: 'Invalid credentials, code, or session.',
})
@ApiResponse({
  status: 403,
  description:
    'The selected contact or credential method is disabled for signup or login.',
})
@ApiResponse({
  status: 429,
  description: 'Attempt budget exhausted; observe Retry-After.',
})
@ApiResponse({
  status: 503,
  description: 'Authentication or local code delivery is unavailable.',
})
@UseFilters(AuthenticationExceptionFilter)
@UseInterceptors(AuthenticationCacheInterceptor)
@Controller('auth')
export class AuthenticationController {
  /** Receive the feature facade; request validation runs through the global Nest validation pipe. */
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
  ) {}

  /** Begin signup with optional password; contact proof is mandatory before activation. */
  @Post('signup')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a signup verification code' })
  @ApiBody({ type: SignupDto })
  @ApiResponse({ status: 202, type: CodeChallengeResponseDto })
  signup(@Body() body: SignupDto, @Ip() clientIp: string) {
    return this.authentication.signup({ ...body, clientIp });
  }

  /** Activate the verified contact with an empty NGN wallet and issue a session exactly once. */
  @Post('signup/verify')
  @HttpCode(201)
  @ApiOperation({ summary: 'Verify signup and create the account' })
  @ApiBody({ type: VerifyCodeDto })
  @ApiResponse({ status: 201, type: AuthenticationResponseDto })
  verifySignup(@Body() body: VerifyCodeDto, @Ip() clientIp: string) {
    return this.authentication.verifySignup({ ...body, clientIp });
  }

  /** Sign in with a verified contact and its existing password. */
  @Post('login/password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in with a phone number or email and password' })
  @ApiBody({ type: PasswordLoginDto })
  @ApiResponse({ status: 200, type: AuthenticationResponseDto })
  loginWithPassword(@Body() body: PasswordLoginDto, @Ip() clientIp: string) {
    return this.authentication.loginWithPassword({
      ...body,
      clientIp,
    });
  }

  /** Redeem a refresh proof once; access expiry does not prevent renewal of its active family. */
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate refresh and access tokens for an active session',
  })
  @ApiBody({ type: RefreshSessionDto })
  @ApiResponse({ status: 200, type: AuthenticationResponseDto })
  refreshSession(@Body() body: RefreshSessionDto, @Ip() clientIp: string) {
    return this.authentication.refreshSession({ ...body, clientIp });
  }

  /** Request a fresh login code without disclosing account existence. */
  @Post('login/code')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a passwordless login code' })
  @ApiBody({ type: RequestLoginCodeDto })
  @ApiResponse({ status: 202, type: CodeChallengeResponseDto })
  requestLoginCode(@Body() body: RequestLoginCodeDto, @Ip() clientIp: string) {
    return this.authentication.requestLoginCode({
      ...body,
      clientIp,
    });
  }

  /** Verify a login-purpose challenge without registering an unknown contact. */
  @Post('login/code/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a login code and create a session' })
  @ApiBody({ type: VerifyCodeDto })
  @ApiResponse({ status: 200, type: AuthenticationResponseDto })
  loginWithCode(@Body() body: VerifyCodeDto, @Ip() clientIp: string) {
    return this.authentication.loginWithCode({ ...body, clientIp });
  }

  /** Request a recovery code with the same response for registered, disabled, and unknown contacts. */
  @Post('password/forgot')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a password-reset code by phone or email' })
  @ApiBody({ type: RequestPasswordResetDto })
  @ApiResponse({ status: 202, type: CodeChallengeResponseDto })
  requestPasswordReset(
    @Body() body: RequestPasswordResetDto,
    @Ip() clientIp: string,
  ) {
    return this.authentication.requestPasswordReset({
      ...body,
      clientIp,
    });
  }

  /** Redeem recovery proof and revoke prior access; the caller must sign in normally afterward. */
  @Post('password/reset')
  @HttpCode(204)
  @ApiOperation({ summary: 'Reset a password with a one-time code' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({
    status: 204,
    description:
      'Password replaced; previous sessions and device keys revoked. Sign in again.',
  })
  async resetPassword(
    @Body() body: ResetPasswordDto,
    @Ip() clientIp: string,
  ): Promise<void> {
    await this.authentication.resetPassword({ ...body, clientIp });
  }

  /** Return only the identity established by the authentication guard. */
  @Get('me')
  @UseGuards(AuthenticationGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current authenticated identity' })
  @ApiResponse({ status: 200, type: AccountIdentityResponseDto })
  me(@Req() request: AuthenticationHttpRequest) {
    return request.account;
  }

  /** Revoke this bearer session idempotently; other device sessions remain valid. */
  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current session' })
  @ApiResponse({
    status: 204,
    description: 'Session revoked or already inactive.',
  })
  async logout(@BearerToken() token: string): Promise<void> {
    await this.authentication.logout(token);
  }
}
