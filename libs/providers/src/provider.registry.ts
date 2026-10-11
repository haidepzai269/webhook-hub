import { ProviderAdapter } from './provider.interface';
import { ProviderType } from '@hub/common';
import { GithubAdapter } from './github.adapter';
import { PayosAdapter } from './payos.adapter';
import { SepayAdapter } from './sepay.adapter';
import { StripeAdapter } from './stripe.adapter';
import { ApiAdapter } from './api.adapter';
import { GenericAdapter } from './generic.adapter';

export class ProviderRegistry {
  private static adapters = new Map<ProviderType, ProviderAdapter>();

  static {
    ProviderRegistry.register(new GithubAdapter());
    ProviderRegistry.register(new PayosAdapter());
    ProviderRegistry.register(new SepayAdapter());
    ProviderRegistry.register(new StripeAdapter());
    ProviderRegistry.register(new ApiAdapter());
    ProviderRegistry.register(new GenericAdapter());
  }

  public static register(adapter: ProviderAdapter): void {
    ProviderRegistry.adapters.set(adapter.provider, adapter);
  }

  /** KN2: provider có adapter đăng ký không (kiểm body `provider` trước khi `get`). */
  public static has(provider: unknown): provider is ProviderType {
    return typeof provider === 'string' && ProviderRegistry.adapters.has(provider as ProviderType);
  }

  /** KN2: mọi adapter — UI liệt kê provider có `connector` (không danh sách cứng ở lõi). */
  public static all(): ProviderAdapter[] {
    return [...ProviderRegistry.adapters.values()];
  }

  public static get(provider: ProviderType): ProviderAdapter {
    const adapter = ProviderRegistry.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Chưa có ProviderAdapter cho nền tảng '${provider}'`);
    }
    return adapter;
  }
}
