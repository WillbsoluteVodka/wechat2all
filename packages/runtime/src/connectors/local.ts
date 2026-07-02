import type { RuntimeConnector, RuntimeHandler } from "../types.js";

export function createLocalConnector(params: {
  id: string;
  name?: string;
  handleMessage: RuntimeHandler;
}): RuntimeConnector {
  return {
    id: params.id,
    name: params.name,
    handleMessage: params.handleMessage,
  };
}
