// Пример простого mock KMS provider и использования (псевдокод)
export class MockKmsProvider {
  constructor(private key: string) {}

  async encrypt(plaintext: Buffer): Promise<Buffer> {
    // НЕ используйте это в проде — для dev/demo только
    return Buffer.from(plaintext.toString('base64'));
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    return Buffer.from(ciphertext.toString(), 'base64');
  }

  async rotateKey(_newKeyId: string) {
    // Implement rotation logic if needed
    return;
  }
}

// Example: register provider in your bootstrap
/*
import { YdbCoreModule } from 'ydb-orm';
const provider = new MockKmsProvider(process.env.DEV_KMS_KEY || 'dev-key');
YdbCoreModule.forRoot({ encryptionProvider: provider });
*/
