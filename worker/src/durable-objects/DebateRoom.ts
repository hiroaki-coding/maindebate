// src/durable-objects/DebateRoom.ts

export class DebateRoom {
  constructor(state: DurableObjectState, env: any) {}

  async fetch(request: Request) {
    return new Response("DebateRoom OK")
  }
}