export type ThemeMode = 'dark' | 'light';

export type TrafficLight = 'green' | 'yellow' | 'red';

export type StatusSeverity = 'green' | 'yellow' | 'red' | 'purple' | 'blue' | 'neutral';

export interface TrafficLightMeta {
  label: string;
  dotClass: string;
  pillClass: string;
  bannerBg: string;
  bannerBorder: string;
}

export const TRAFFIC_LIGHT_META: Record<TrafficLight, TrafficLightMeta> = {
  green: {
    label: 'READY',
    dotClass: 'bg-green-ready',
    pillClass: 'text-green-ready bg-green-ready-bg border-green-ready-border',
    bannerBg: 'var(--green-ready-bg)',
    bannerBorder: 'var(--green-ready)',
  },
  yellow: {
    label: 'ATTENTION',
    dotClass: 'bg-yellow-attention',
    pillClass: 'text-yellow-attention bg-yellow-attention-bg border-yellow-attention-border',
    bannerBg: 'var(--yellow-attention-bg)',
    bannerBorder: 'var(--yellow-attention)',
  },
  red: {
    label: 'ACTION REQUIRED',
    dotClass: 'bg-red-action',
    pillClass: 'text-red-action bg-red-action-bg border-red-action-border',
    bannerBg: 'var(--red-action-bg)',
    bannerBorder: 'var(--red-action)',
  },
};
