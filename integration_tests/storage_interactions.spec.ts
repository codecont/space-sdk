import { AddItemsEventData, AddItemsResultSummary, UserStorage } from '@spacehq/sdk';
import { isNode } from 'browser-or-node';
import fs from 'fs';
import { expect, use } from 'chai';
import * as chaiSubset from 'chai-subset';
import path from 'path';
import { TestsDefaultTimeout } from './fixtures/configs';
import { authenticateAnonymousUser } from './helpers/userHelper';

use(chaiSubset.default);

describe('Users storing data', () => {
  it('user should create an empty folder successfully', async () => {
    const { user } = await authenticateAnonymousUser();

    const storage = new UserStorage(user);
    await storage.createFolder({ bucket: 'personal', path: 'topFolder' });

    // verify folder is added
    const listFolder = await storage.listDirectory({ bucket: 'personal', path: '' });
    expect(listFolder.items).to.containSubset([
      {
        name: 'topFolder',
        isDir: true,
      },
    ]);

    // validate empty .keep file is at folders root
    const fileResponse = await storage.openFile({ bucket: 'personal', path: '/topFolder/.keep' });
    const keepFilesContent = await fileResponse.consumeStream();
    // eslint-disable-next-line no-unused-expressions
    expect(keepFilesContent).to.be.empty;
  }).timeout(TestsDefaultTimeout);

  it('user should upload files successfully', async () => {
    const { user } = await authenticateAnonymousUser();
    const txtContent = 'Some manual text should be in the file';

    const storage = new UserStorage(user);
    const uploadResponse = await storage.addItems({
      bucket: 'personal',
      files: [
        {
          path: 'top.txt',
          data: txtContent,
          mimeType: 'plain/text',
        },
        {
          path: 'subfolder/inner.txt',
          data: 'some other stuffs',
          mimeType: 'plain/text',
        },
      ],
    });

    let summary: AddItemsResultSummary | undefined;
    await new Promise((resolve) => {
      uploadResponse.once('done', (data: AddItemsEventData) => {
        summary = data as AddItemsResultSummary;
        resolve();
      });
    });

    expect(summary).to.containSubset({
      bucket: 'personal',
      files: [
        {
          path: '/top.txt',
          status: 'success',
        },
        {
          path: '/subfolder/inner.txt',
          status: 'success',
        },
        {
          path: '/subfolder',
          status: 'success',
        },
      ],
    });

    // 3rd level upload
    const anotheruploadResponse = await storage.addItems({
      bucket: 'personal',
      files: [
        {
          path: 'firstfolder/secondfolder/file.txt',
          data: txtContent,
          mimeType: 'plain/text',
        },
      ],
    });

    // validate files are in the directory
    const listFolder = await storage.listDirectory({ bucket: 'personal', path: '' });
    expect(listFolder.items).to.containSubset([
      {
        name: 'top.txt',
        isDir: false,
      },
      {
        name: 'subfolder',
        isDir: true,
      },
    ]);

    const listFolderRec = await storage.listDirectory({ bucket: 'personal', path: '', recursive: true });

    // validate content of top.txt file
    const fileResponse = await storage.openFile({ bucket: 'personal', path: '/top.txt' });
    const actualTxtContent = await fileResponse.consumeStream();
    expect(new TextDecoder('utf8').decode(actualTxtContent)).to.equal(txtContent);
    expect(fileResponse.mimeType).to.equal('plain/text');
  }).timeout(TestsDefaultTimeout);

  it('should open large files successfully', async () => {
    if (!isNode) {
      return;
    }

    const { user } = await authenticateAnonymousUser();
    const imageBytes = fs.readFileSync(path.join(__dirname, 'test_data', 'image.jpg'));
    const storage = new UserStorage(user);
    const uploadResponse = await storage.addItems({
      bucket: 'personal',
      files: [
        {
          path: 'image.jpg',
          data: imageBytes,
          mimeType: 'image/jpg',
        },
      ],
    });

    await new Promise<AddItemsEventData>((resolve) => {
      uploadResponse.once('done', resolve);
    });

    const openResponse = await storage.openFile({
      bucket: 'personal',
      path: '/image.jpg',
    });

    const actualBytes = await openResponse.consumeStream();
    expect(Buffer.from(actualBytes)).to.deep.equal(imageBytes);
  });
});
