/**
 * Сервис пользователей с шифрованием.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository, YdbRepository } from '../../../src/nest/index.js';
import { EncryptedUserEntity } from '../../shared/entities/index.js';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(EncryptedUserEntity)
    private readonly users: YdbRepository<EncryptedUserEntity>,
  ) {}

  async register(
    name: string,
    email: string,
    governmentId: string,
  ): Promise<EncryptedUserEntity> {
    const user = new EncryptedUserEntity();
    user.name = name;
    user.email = email;
    user.government_id = governmentId;
    return this.users.save(user);
  }

  /** Поиск по полю с blind index (email): работает, несмотря на шифрование. */
  async findByEmail(email: string): Promise<EncryptedUserEntity | null> {
    return this.users.find({ email });
  }

  async cleanup(user: EncryptedUserEntity): Promise<void> {
    await this.users.delete(user.uuid);
  }
}
