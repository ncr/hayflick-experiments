export type ExperimentContext = {
  mount: HTMLElement;
  width: number;
  height: number;
  dpr: number;
};

export type ExperimentModule = {
  id: string;
  title: string;
  tags: string[];
  init(ctx: ExperimentContext): Promise<() => void> | (() => void);
};
