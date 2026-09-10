import type { Student } from '@roster/types';
import { Elysia } from 'elysia';
import { rows, sql } from '../db';

export const studentRoutes = new Elysia({ prefix: '/api' }).get('/students', () =>
  rows(sql<Student[]>`
    SELECT s.id, s.parent_id, s.name, p.name AS parent_name
    FROM students s
    JOIN parents p ON p.id = s.parent_id
    ORDER BY p.name, s.name`),
);
