/**
 * Локальная сущность для примера 11-advanced: lifecycle-хуки.
 * Хуки объявляются обычными методами с декораторами:
 * @BeforeInsert/@AfterInsert/@BeforeUpdate/@AfterFind/@BeforeRemove.
 */
import {
  AfterFind,
  AfterInsert,
  BeforeInsert,
  BeforeRemove,
  BeforeUpdate,
  YdbBaseEntity,
  YdbColumn,
  YdbEntity,
  YdbPrimaryColumn,
} from '../../src/index.js';

@YdbEntity('audit_events')
export class AuditEventEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbColumn('Utf8')
  note: string;

  @BeforeInsert
  beforeInsert(): void {
    this.note = `created@${new Date().toISOString()}`;
  }

  @AfterInsert
  afterInsert(): void {
    console.log(`[hook] afterInsert: ${this.name}`);
  }

  @BeforeUpdate
  beforeUpdate(): void {
    this.note = `updated@${new Date().toISOString()}`;
  }

  @AfterFind
  afterFind(): void {
    this.note = this.note + ' [прочитано]';
  }

  @BeforeRemove
  beforeRemove(): void {
    console.log(`[hook] beforeRemove: ${this.name}`);
  }
}
