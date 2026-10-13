import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
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
import {
  readBearerToken,
  type AuthenticationHttpRequest,
} from '../types/authentication-http.js';
import {
  SignupDto,
  VerifyCodeDto,
  PasswordLoginDto,
  RequestLoginCodeDto,
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
  signup(@Body() body: SignupDto, @Req() request: AuthenticationHttpRequest) {
    return this.authentication.signup({ ...body, clientIp: request.ip });
  }

  /** Activate a verified contact and issue a session exactly once. */
  @Post('signup/verify')
  @HttpCode(201)
  @ApiOperation({ summary: 'Verify signup and create the account' })
  @ApiBody({ type: VerifyCodeDto })
  @ApiResponse({ status: 201, type: AuthenticationResponseDto })
  verifySignup(
    @Body() body: VerifyCodeDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.authentication.verifySignup({ ...body, clientIp: request.ip });
  }

  /** Sign in with a verified contact and its existing password. */
  @Post('login/password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in with a phone number or email and password' })
  @ApiBody({ type: PasswordLoginDto })
  @ApiResponse({ status: 200, type: AuthenticationResponseDto })
  loginWithPassword(
    @Body() body: PasswordLoginDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.authentication.loginWithPassword({
      ...body,
      clientIp: request.ip,
    });
  }

  /** Request a fresh login code without disclosing account existence. */
  @Post('login/code')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a passwordless login code' })
  @ApiBody({ type: RequestLoginCodeDto })
  @ApiResponse({ status: 202, type: CodeChallengeResponseDto })
  requestLoginCode(
    @Body() body: RequestLoginCodeDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.authentication.requestLoginCode({
      ...body,
      clientIp: request.ip,
    });
  }

  /** Verify a login-purpose challenge without registering an unknown contact. */
  @Post('login/code/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a login code and create a session' })
  @ApiBody({ type: VerifyCodeDto })
  @ApiResponse({ status: 200, type: AuthenticationResponseDto })
  loginWithCode(
    @Body() body: VerifyCodeDto,
    @Req() request: AuthenticationHttpRequest,
  ) {
    return this.authentication.loginWithCode({ ...body, clientIp: request.ip });
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
  async logout(@Req() request: AuthenticationHttpRequest): Promise<void> {
    await this.authentication.logout(
      readBearerToken(request.headers.authorization),
    );
  }
}
