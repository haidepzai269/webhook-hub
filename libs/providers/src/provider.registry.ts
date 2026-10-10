import { ProviderAdapter } from './provider.interface';
import { ProviderType } from '@hub/common';
import { GithubAdapter } from './github.adapter';
import { PayosAdapter } from './payos.adapter';
import { SepayAdapter } from './sepay.adapter';
import { StripeAdapter } from './stripe.adapter';
import { ApiAdapter } from './api.adapter';

export class ProviderRegistry {
  private static adapters = new Map<ProviderType, ProviderAdapter>();

  static {
    ProviderRegistry.register(new GithubAdapter());
    ProviderRegistry.register(new PayosAdapter());
    ProviderRegistry.register(new SepayAdapter());
    ProviderRegistry.register(new StripeAdapter());
    ProviderRegistry.register(new ApiAdapter());
  }

  public static register(adapter: ProviderAdapter): void {
    ProviderRegistry.adapters.set(adapter.provider, adapter);
  }

  public static get(provider: ProviderType): ProviderAdapter {
    const adapter = ProviderRegistry.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Chưa có ProviderAdapter cho nền tảng '${provider}'`);
    }
    return adapter;
  }
}
