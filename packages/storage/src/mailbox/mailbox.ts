import { Users, Update, ThreadID, InboxListOptions, UserMessage, PrivateKey, Public, privateKeyFromString, PublicKey } from '@textile/hub';
import { grpc } from '@improbable-eng/grpc-web';
import ee from 'event-emitter';
import { threadId } from 'worker_threads';

export class Mailbox {
  private client: Users;

  public constructor(client: Users) {
    this.client = client;
  }

  //   public async ListInboxMessages(opts: InboxListOptions):[]UserMessage {
  //     const messages = await this.client.listInboxMessages();
  //     const inbox = [];
  //     messages.forEach(async (msg) => {
  //       inbox.push(await this.messageDecoder(msg));
  //     });
  // PrivateKey.fromString

  //   };

  public async SendMessage(from: string, to: string, body:Uint8Array): Promise<UserMessage> {
    const fromkey = PrivateKey.fromString(from);
    const tokey = PublicKey.fromString(to);
    return this.client.sendMessage(fromkey, tokey, body);
  }

  // public WatchInbox():ee {

  // }

  // public Identity():PrivateKey {

  // }

  // private parseMessage(msgs:UserMessage[]) {

  // }

  /**
   * Decrypts a user's inbox messages using their PrivateKey
   */
  // messageDecoder = async (message: UserMessage): Promise<DecryptedInbox> => {
  //   const identity = PrivateKey.fromString(PrivateKeyIdentity);
  //   const bytes = await identity.decrypt(message.body);
  //   const body = new TextDecoder().decode(bytes);
  //   const { from } = message;
  //   const { readAt } = message;
  //   const { createdAt } = message;
  //   const { id } = message;
  //   return { body, from, readAt, sent: createdAt, id };
  // }
}
