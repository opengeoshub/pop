import { Container, getContainer } from "@cloudflare/containers";

export class PopContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true;
}

export default {
  async fetch(
    request: Request,
    env: { POP_CONTAINER: DurableObjectNamespace<PopContainer> },
  ): Promise<Response> {
    return getContainer(env.POP_CONTAINER, "main").fetch(request);
  },
};
