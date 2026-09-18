import { DestinationSender } from './sender.interface';
import { DestinationType } from '@hub/common';
import { DiscordSender } from './discord.sender';
import { TelegramSender } from './telegram.sender';
import { WebhookSender } from './webhook.sender';

export class SenderRegistry {
  private static senders = new Map<DestinationType, DestinationSender>();

  static {
    SenderRegistry.register(new DiscordSender());
    SenderRegistry.register(new TelegramSender());
    SenderRegistry.register(new WebhookSender());
  }

  public static register(sender: DestinationSender): void {
    SenderRegistry.senders.set(sender.type, sender);
  }

  public static get(type: DestinationType): DestinationSender {
    const sender = SenderRegistry.senders.get(type);
    if (!sender) {
      throw new Error(`Chưa có Sender cho loại đích '${type}'`);
    }
    return sender;
  }
}
