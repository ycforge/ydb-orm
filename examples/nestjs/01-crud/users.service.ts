/**
 * Сервис пользователей NestJS: репозиторий через DI.
 * Токен репозитория = getRepositoryToken(UserEntity), сокращение —
 * декоратор @InjectRepository(Entity).
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository, YdbRepository } from '../../../src/nest/index.js';
import { UserEntity } from '../../shared/entities/index.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: YdbRepository<UserEntity>,
  ) {}

  // Репозиторий — тот же инстанс, что использует Active Record
  // (UserEntity.save(...) === this.users.save(...)).

  async create(name: string, email: string): Promise<UserEntity> {
    const user = new UserEntity();
    user.name = name;
    user.email = email;
    user.organization = 'acme';
    return this.users.save(user);
  }

  async findByName(name: string): Promise<UserEntity[]> {
    return this.users.findAll({ name });
  }

  async cleanup(user: UserEntity): Promise<void> {
    await this.users.delete(user.uuid);
  }
}
