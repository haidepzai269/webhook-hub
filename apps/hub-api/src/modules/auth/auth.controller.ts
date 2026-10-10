import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService, LoginResponse } from './auth.service';

interface LoginDto {
  username: string;
  password: string;
}

/**
 * Route công khai (KHÔNG áp JwtAuthGuard) — đây là nơi duy nhất tạo JWT.
 * Không có đăng ký, không refresh token (ARCHITECTURE.md §7.4).
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto): Promise<LoginResponse> {
    return this.authService.login(body?.username, body?.password);
  }
}
