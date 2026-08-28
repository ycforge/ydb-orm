import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToMany,
  ManyToOne,
  ManyToMany,
  JoinTable,
  getOrCreateRepository,
} from '../src/index.js';
import { createMockExecutor } from './helpers/mock-executor.js';

/**
 * Регрессионные тесты #174: Keys (Bytes/Date) relations по значению.
 *
 * Гидрация создаёт для каждой строки НОВЫЙ инстанс Uint8Array/Date.
 * Раньше relations-мапы (byFk/byPk/byInversePk/related) индексировались
 * по ССЫЛКЕ: владелец с PK-инстансом A не «находил» строку, у которой FK
 * — байт-равный, но другой инстанс B. Валидные связи на Bytes/Date-ключах
 * схлопывались в пустые/null. Теперь ключ — канонический value-ключ.
 */

// ---- Bytes-фикстура: doc → pages (1:N), pages → doc (N:1), doc ↔ tags (N:M) ----

@YdbEntity('vk_docs')
class ValueKeyDocEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Bytes')
  id: Uint8Array;

  @YdbColumn('Utf8')
  title: string;

  @OneToMany(() => ValueKeyPageEntity, 'doc_id')
  pages?: any[];

  @ManyToMany(() => ValueKeyTagEntity, (tag) => tag.docs)
  @JoinTable('vk_doc_tag', {
    joinColumn: 'doc_id',
    inverseJoinColumn: 'tag_id',
  })
  tags?: any[];
}

@YdbEntity('vk_pages')
class ValueKeyPageEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Bytes')
  id: Uint8Array;

  @YdbColumn('Bytes')
  doc_id: Uint8Array;

  @ManyToOne(() => ValueKeyDocEntity, 'doc_id')
  doc?: any;
}

@YdbEntity('vk_tags')
class ValueKeyTagEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Bytes')
  id: Uint8Array;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => ValueKeyDocEntity, (doc) => doc.tags)
  docs?: any[];
}

// ---- Date-фикстура: event (Datetime PK) → tickets (1:N), ticket → event (N:1) ----

@YdbEntity('vk_events')
class ValueKeyEventEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Datetime')
  at: Date;

  @YdbColumn('Utf8')
  name: string;

  @OneToMany(() => ValueKeyTicketEntity, 'event_at')
  tickets?: any[];
}

@YdbEntity('vk_tickets')
class ValueKeyTicketEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  code: string;

  @YdbColumn('Datetime')
  event_at: Date;

  @ManyToOne(() => ValueKeyEventEntity, 'event_at')
  event?: any;
}

const DOC_ID = new Uint8Array([1, 2, 3]);
const EVENT_AT = new Date('2026-08-28T10:00:00.000Z');

describe('#174: relation keys по значению (Bytes/Date)', () => {
  describe('Bytes-ключи', () => {
    it('one-to-many: FK ребёнка — другой инстанс Uint8Array, байт-равный PK владельца', async () => {
      const doc = Object.assign(new ValueKeyDocEntity(), {
        id: DOC_ID,
        title: 'doc',
      });
      // Второй инстанс владельца с байт-равным PK — дедупликация IN.
      const dupe = Object.assign(new ValueKeyDocEntity(), {
        id: new Uint8Array([1, 2, 3]),
        title: 'dup',
      });

      const childRows = [
        { id: new Uint8Array([10]), doc_id: new Uint8Array([1, 2, 3]) },
        { id: new Uint8Array([11]), doc_id: new Uint8Array([1, 2, 3]) },
      ];
      const mock = createMockExecutor([childRows]);
      ValueKeyDocEntity.setExecutor(mock.executor);
      ValueKeyPageEntity.setExecutor(mock.executor);

      await getOrCreateRepository(ValueKeyDocEntity).relations.loadRelations(
        [doc, dupe],
        ['pages'],
      );

      // Байт-равные PK → один параметр, а не два.
      expect(mock.queries).toHaveLength(1);
      expect(Object.keys(mock.queries[0].params)).toHaveLength(1);

      expect(doc.pages?.length).toBe(2);
      expect(doc.pages!.map((p) => p.id)).toEqual([
        new Uint8Array([10]),
        new Uint8Array([11]),
      ]);
      expect(dupe.pages?.length).toBe(2);
    });

    it('many-to-one: FK строки — другой инстанс, PK родителя — третий', async () => {
      const page = Object.assign(new ValueKeyPageEntity(), {
        id: new Uint8Array([10]),
        doc_id: new Uint8Array([1, 2, 3]),
      });

      const parentRows = [{ id: new Uint8Array([1, 2, 3]), title: 'doc' }];
      const mock = createMockExecutor([parentRows]);
      ValueKeyPageEntity.setExecutor(mock.executor);
      ValueKeyDocEntity.setExecutor(mock.executor);

      await getOrCreateRepository(ValueKeyPageEntity).relations.loadRelations(
        [page],
        ['doc'],
      );

      expect(page.doc).not.toBeNull();
      expect(page.doc!.title).toBe('doc');
      expect(page.doc!.id).toEqual(DOC_ID);
    });

    it('many-to-many: инверсный PK и owner-FK — независимые инстансы', async () => {
      const doc = Object.assign(new ValueKeyDocEntity(), {
        id: new Uint8Array([9]),
        title: 'doc',
      });

      const linkRows = [
        { doc_id: new Uint8Array([9]), tag_id: new Uint8Array([21]) },
        { doc_id: new Uint8Array([9]), tag_id: new Uint8Array([22]) },
        // Ссылка на тег, отсутствующий в tagRows (напр. удалённый) — skip.
        { doc_id: new Uint8Array([9]), tag_id: new Uint8Array([99]) },
      ];
      const tagRows = [
        { id: new Uint8Array([21]), label: 'a' },
        { id: new Uint8Array([22]), label: 'b' },
      ];

      const mock = createMockExecutor([[linkRows], [tagRows]], {
        sequential: true,
      });
      ValueKeyDocEntity.setExecutor(mock.executor);
      ValueKeyTagEntity.setExecutor(mock.executor);

      await getOrCreateRepository(ValueKeyDocEntity).relations.loadRelations(
        [doc],
        ['tags'],
      );

      expect(doc.tags?.length).toBe(2);
      expect(doc.tags!.map((t) => t.label).sort()).toEqual(['a', 'b']);
      expect(doc.tags!.map((t) => t.id)).toEqual([
        new Uint8Array([21]),
        new Uint8Array([22]),
      ]);
    });
  });

  describe('Date-ключи', () => {
    it('many-to-one: FK строки — другой Date-инстанс, равный PK родителя', async () => {
      const ticket = Object.assign(new ValueKeyTicketEntity(), {
        code: 't1',
        event_at: new Date('2026-08-28T10:00:00.000Z'),
      });

      const parentRows = [{ at: EVENT_AT, name: 'party' }];
      const mock = createMockExecutor([parentRows]);
      ValueKeyTicketEntity.setExecutor(mock.executor);
      ValueKeyEventEntity.setExecutor(mock.executor);

      await getOrCreateRepository(ValueKeyTicketEntity).relations.loadRelations(
        [ticket],
        ['event'],
      );

      expect(ticket.event).not.toBeNull();
      expect(ticket.event!.name).toBe('party');
      expect(ticket.event!.at.getTime()).toBe(EVENT_AT.getTime());
    });

    it('one-to-many: FK детей — отдельные Date-инстансы по event_at владельца', async () => {
      const event = Object.assign(new ValueKeyEventEntity(), {
        at: EVENT_AT,
        name: 'party',
      });

      const childRows = [
        { code: 't1', event_at: new Date('2026-08-28T10:00:00.000Z') },
        { code: 't2', event_at: new Date('2026-08-28T10:00:00.000Z') },
        // Чужой event — другой слот времени, в группе быть не должен.
        { code: 't-other', event_at: new Date('2026-08-28T11:00:00.000Z') },
      ];
      const mock = createMockExecutor([childRows]);
      ValueKeyEventEntity.setExecutor(mock.executor);
      ValueKeyTicketEntity.setExecutor(mock.executor);

      await getOrCreateRepository(ValueKeyEventEntity).relations.loadRelations(
        [event],
        ['tickets'],
      );

      expect(event.tickets?.length).toBe(2);
      expect(event.tickets!.map((t) => t.code).sort()).toEqual(['t1', 't2']);
    });
  });
});
