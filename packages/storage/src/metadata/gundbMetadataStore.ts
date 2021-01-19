/* eslint-disable no-underscore-dangle */
import { isNode } from 'browser-or-node';
import { IGunChainReference } from 'gun/types/chain';
import { IGunStatic } from 'gun/types/static';
import { BucketMetadata, FileMetadata, UserMetadataStore } from './metadataStore';

let Gun: IGunStatic;
if (isNode) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires,global-require
  Gun = require('gun');
} else {
  // eslint-disable-next-line @typescript-eslint/no-var-requires,global-require
  Gun = require('gun/gun');
  // eslint-disable-next-line @typescript-eslint/no-var-requires,global-require
  require('gun/sea');
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('crypto-browserify');

// this is an hack to enable using IGunChainReference in async functions
export type GunChainReference<Data> = Omit<IGunChainReference<Data>, 'then'>;

// 32 bytes aes key + 16 bytes salt/IV + 32 bytes HMAC key
const BucketEncryptionKeyLength = 32 + 16 + 32;
const BucketMetadataCollection = 'BucketMetadata';
const PublicStoreUsername = 'GunSpaceMetadata';
const PublicStorePassword = Buffer.from('98d93000aebf8898a9156cb20b2e5c9b0821dd63').toString('hex');

interface AckError {
  err: string;
}

// Remapped bucket metadata type compatible with Gundb
type GunBucketMetadata = Omit<BucketMetadata, 'encryptionKey'> & { encryptionKey: string };
type GunFileMetadata = { data: string };
type EncryptedMetadata = { data: string; };

interface LookupDataState {
  [dbIdBucket: string]: EncryptedMetadata;
}

interface LookupFileMetadataState {
  [lookupId: string]: GunFileMetadata;
}

interface ListDataState {
  [collectionName: string]: EncryptedMetadata[]
}

// Data schema of records stored in gundb
// currently only a single bucket metadata collection
export type GunDataState = LookupDataState | ListDataState | LookupFileMetadataState;

type GunInit = (() => GunChainReference<GunDataState>);

/**
 * A Users Storage Metadata store backed by gundsdb.
 *
 * This is the default MetadataStore used by {@link @spacehq/sdk#UserStorage}.
 *
 */
export class GundbMetadataStore implements UserMetadataStore {
  private gunInit: GunInit;

  // in memory cache list of buckets
  private bucketsListCache: BucketMetadata[];

  private _user?: GunChainReference<GunDataState>;

  private _publicUser?: GunChainReference<GunDataState>;

  /**
   * Creates a new instance of this metadata store for users identity.
   *
   * @param username - public key of the user
   * @param userpass - user identity derived password
   * @param gunOrServer - initialized gun instance or peer server
   */
  private constructor(
    private readonly username: string,
    private readonly userpass: string,
    gunOrServer?: GunInit | string,
  ) {
    if (gunOrServer) {
      if (typeof gunOrServer === 'string') {
        this.gunInit = () => Gun({ web: gunOrServer });
      } else {
        this.gunInit = gunOrServer;
      }
    } else {
      this.gunInit = () => Gun();
    }

    this.bucketsListCache = [];
  }

  /**
   * Creates a new instance of this metadata store for users identity.
   *
   * @param username - Username of user
   * @param userpass - Password of user
   * @param gunOrServer - initialized gun instance or peer server
   */
  static async fromIdentity(
    username: string,
    userpass: string,
    gunOrServer?: GunInit | string,
  ): Promise<GundbMetadataStore> {
    const store = new GundbMetadataStore(username, userpass, gunOrServer);

    store._user = store.gunInit().user();
    await store.authenticateUser(store._user, username, userpass);
    store._publicUser = store.gunInit().user();
    await store.authenticateUser(store._publicUser, PublicStoreUsername, PublicStorePassword);

    await store.startCachingBucketsList();

    return store;
  }

  /**
   * {@inheritDoc @spacehq/sdk#UserMetadataStore.createBucket}
   */
  public async createBucket(bucketSlug: string, dbId: string): Promise<BucketMetadata> {
    // throw if dbId with bucketSlug doesn't already
    const existingBucket = await this.findBucket(bucketSlug);
    if (existingBucket) {
      throw new Error('Bucket with slug and dbId already exists');
    }

    const schema: BucketMetadata = {
      dbId,
      encryptionKey: crypto.randomBytes(BucketEncryptionKeyLength),
      slug: bucketSlug,
    };
    const encryptedMetadata = await this.encryptBucketSchema(schema);
    const lookupKey = this.getBucketsLookupKey(bucketSlug);

    const nodeRef = this.lookupUser.get(lookupKey).put(encryptedMetadata);
    // store in list too. the unknown cast is required because of typescripts limitation
    // but it to ensure that the set has a reference to the actual data
    this.listUser.get(BucketMetadataCollection).set(nodeRef as unknown as EncryptedMetadata);

    return schema;
  }

  /**
   * {@inheritDoc @spacehq/sdk#UserMetadataStore.findBucket}
   */
  public async findBucket(bucketSlug: string): Promise<BucketMetadata | undefined> {
    const lookupKey = this.getBucketsLookupKey(bucketSlug);
    const encryptedData = await new Promise<EncryptedMetadata | undefined>((resolve, reject) => {
      this.lookupUser.get(lookupKey).once((data) => {
        resolve(data);
      });
    });
    // unregister lookup
    this.lookupUser.get(lookupKey).off();

    if (!encryptedData) {
      return undefined;
    }

    return this.decryptBucketSchema(encryptedData);
  }

  /**
   * {@inheritDoc @spacehq/sdk#UserMetadataStore.listBuckets}
   */
  public async listBuckets(): Promise<BucketMetadata[]> {
    return this.bucketsListCache;
  }

  /**
   * {@inheritDoc @spacehq/sdk#UserMetadataStore.upsertFileMetadata}
   */
  public async upsertFileMetadata(
    metadata: FileMetadata,
  ): Promise<FileMetadata> {
    const { bucketSlug, dbId, path } = metadata;
    const lookupKey = GundbMetadataStore.getFilesLookupKey(bucketSlug, dbId, path);
    const existingFileMetadata = await this.findFileMetadata(bucketSlug, dbId, path);

    let updatedMetadata = metadata;
    if (existingFileMetadata) {
      updatedMetadata = {
        ...existingFileMetadata,
        ...metadata,
      };
    }

    const encryptedMetadata = await this.encrypt(JSON.stringify(updatedMetadata));
    this.lookupUser.get(lookupKey).put({ data: encryptedMetadata });

    if (updatedMetadata.uuid) {
      // store a lookup record of the file by uuid
      this.lookupUser.get(GundbMetadataStore.getFilesUuidLookupKey(updatedMetadata.uuid))
        .put({ data: encryptedMetadata });
    }

    return updatedMetadata;
  }

  /**
   * {@inheritDoc @spacehq/sdk#UserMetadataStore.findFileMetadata}
   */
  public async findFileMetadata(
    bucketSlug:string,
    dbId: string,
    path: string,
  ): Promise<FileMetadata | undefined> {
    const lookupKey = GundbMetadataStore.getFilesLookupKey(bucketSlug, dbId, path);
    return this.lookupFileMetadata(lookupKey);
  }

  /**
   * {@inheritDoc @spacehq/sdk#UserMetadataStore.findFileMetadataByUuid}
   */
  public async findFileMetadataByUuid(uuid: string): Promise<FileMetadata | undefined> {
    const lookupKey = GundbMetadataStore.getFilesUuidLookupKey(uuid);

    // NOTE: This can be speedup by making this fetch promise a race instead of sequential
    return this.lookupFileMetadata(lookupKey).then((data) => {
      if (!data) {
        return this.lookupPublicFileMetadata(lookupKey);
      }
      return data;
    });
  }

  /**
   * {@inheritDoc @spacehq/sdk#UserMetadataStore.setFilePublic}
   */
  public async setFilePublic(metadata: FileMetadata): Promise<void> {
    if (metadata.uuid === undefined) {
      throw new Error('metadata file must have a uuid');
    }

    const lookupKey = GundbMetadataStore.getFilesUuidLookupKey(metadata.uuid);

    this.publicLookupChain.get(lookupKey).put({ data: JSON.stringify(metadata) });
  }

  private async lookupFileMetadata(lookupKey: string): Promise<FileMetadata | undefined> {
    const encryptedData = await new Promise<EncryptedMetadata | null>((resolve, reject) => {
      this.lookupUser.get(lookupKey).once((data) => {
        resolve(data);
      });
    });
    // unregister lookup
    this.lookupUser.get(lookupKey).off();

    if (!encryptedData) {
      return undefined;
    }

    return this.decrypt<FileMetadata>(encryptedData.data);
  }

  private async lookupPublicFileMetadata(lookupKey: string): Promise<FileMetadata | undefined> {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const metadata = await new Promise<GunFileMetadata | null>((resolve, reject) => {
      this.publicLookupChain.get(lookupKey).once((data) => {
        resolve(data);
      });
    });
    // unregister lookup
    this.publicLookupChain.get(lookupKey).off();

    if (!metadata) {
      return undefined;
    }

    // Note: should probably do some validation on the data here
    return JSON.parse(metadata.data) as FileMetadata;
  }

  private async startCachingBucketsList(): Promise<void> {
    this.listUser.get(BucketMetadataCollection).map().once(async (data) => {
      if (data) {
        try {
          const decryptedData = await this.decryptBucketSchema(data);
          this.bucketsListCache.push(decryptedData);
        } catch (err) {
          // an error occurred. most likely not our data
        }
      }
    });

    // wait a few seconds so results would start filling cache before returning
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  private getBucketsLookupKey(bucketSlug: string): string {
    return `bucketSchema/${bucketSlug}/${this.username}`;
  }

  private static getFilesLookupKey(bucketSlug: string, dbId: string, path: string): string {
    return `fileMetadata/${bucketSlug}/${dbId}/${path}`;
  }

  private static getFilesUuidLookupKey(uuid: string): string {
    return `/fuuid/${uuid}`;
  }

  private get user(): GunChainReference<GunDataState> {
    if (!this._user || !(this._user as unknown as { is?: Record<never, never>; }).is) {
      throw new Error('gundb user not authenticated');
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._user!;
  }

  private get publicUser(): GunChainReference<GunDataState> {
    if (!this._publicUser || !(this._publicUser as unknown as { is?: Record<never, never>; }).is) {
      throw new Error('gundb user not authenticated');
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._publicUser!;
  }

  // use this alias getter for lookuping up users metadata so typescript works as expected
  private get lookupUser(): GunChainReference<LookupDataState> {
    return this.user as GunChainReference<LookupDataState>;
  }

  // use this alias getter for listening to users metadata list so typescript works as expected
  private get listUser(): GunChainReference<ListDataState> {
    return this.user as GunChainReference<ListDataState>;
  }

  private get publicLookupChain(): GunChainReference<LookupFileMetadataState> {
    return this.publicUser as GunChainReference<LookupFileMetadataState>;
  }

  // eslint-disable-next-line class-methods-use-this
  private async authenticateUser<T>(
    user: GunChainReference<T>,
    username: string,
    userpass: string,
  ): Promise<void> {
    // user.is checks if user is currently logged in
    if ((user as unknown as { is?: Record<never, never>; }).is) {
      return;
    }

    await new Promise((resolve, reject) => {
      // eslint-disable-next-line no-unused-expressions
      user.create(username, userpass, (ack) => {
        // if ((ack as AckError).err) {
        //   // error here means user either exists or is being created, see gundb user docs.
        //   // so ignoring
        //   return;
        // }

        // eslint-disable-next-line no-unused-expressions
        user.auth(username, userpass, (auth) => {
          if ((auth as AckError).err) {
            reject(new Error(`gundb failed to authenticate user: ${(auth as AckError).err}`));
            return;
          }
          resolve();
        });
      });
    });
  }

  // encrypts data with users private key
  private async encrypt(data: string): Promise<string> {
    return Gun.SEA.encrypt(data, this.userpass);
  }

  private async decrypt<T>(data: string): Promise<T | undefined> {
    return ((Gun.SEA.decrypt(data, this.userpass)) as Promise<T | undefined>);
  }

  private async encryptBucketSchema(schema: BucketMetadata): Promise<EncryptedMetadata> {
    return {
      data: await this.encrypt(JSON.stringify({
        ...schema,
        encryptionKey: Buffer.from(schema.encryptionKey).toString('hex'),
      })),
    };
  }

  private async decryptBucketSchema(encryptedSchema: EncryptedMetadata): Promise<BucketMetadata> {
    const gunschema = await this.decrypt<GunBucketMetadata>(encryptedSchema.data);
    if (!gunschema) {
      throw new Error('Unknown bucket metadata');
    }

    return {
      ...gunschema,
      encryptionKey: Buffer.from(gunschema.encryptionKey, 'hex'),
    };
  }
}
