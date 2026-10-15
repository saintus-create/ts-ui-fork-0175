export type ModelOption = {
  value: string;
  name: string;
  icon: string;
  disabled?: boolean;
};

export const MODELS: ModelOption[] = [
  {
    value: "sarvam-105b-conversations",
    name: "Sarvam 105B",
    icon: "/favicon.svg",
  },
];

export const DEFAULT_MODEL_ID = MODELS[0]!.value;
