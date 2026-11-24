import { createClient } from "redis";

const subscriber = createClient();
subscriber.on("error", (err) => console.error("Redis Client Error", err));

async function main() {
  await subscriber.connect();

  const blockingClient = subscriber.duplicate();
  await blockingClient.connect();

  while (true) {
    const response = await blockingClient.brPop("build-queue", 0);
    if (response) console.log("Received job:", response.element);
  }
}

main();
