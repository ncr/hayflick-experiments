export type ExperimentStatus = "draft" | "stable" | "archived";

export type ExperimentMeta = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  status: ExperimentStatus;
  updatedAt: string;
};

export type ExperimentRegistryEntry = ExperimentMeta & {
  load: () => Promise<{ default: import("./types").ExperimentModule }>;
};
