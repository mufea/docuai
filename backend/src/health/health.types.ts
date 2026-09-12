export type DependencyStatus = 'up' | 'down';

export interface HealthSnapshot {
  status: 'ok' | 'error';
  service: string;
  database: DependencyStatus;
  redis: DependencyStatus;
}
