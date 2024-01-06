# nestjs-waiting-room-middleware-keepalive
Middleware for NestJS using HTTP keep-alive to provide waiting room functionality

## How it works
If a client requests a route, the middleware checks whether the client is allowed to proceed with its request based on defined limits.

If the client has to wait, the middleware will initialize a keep-alive connection and send a ```WaitingRoomResponse { queuePosition: number }``` if the position has changed. It will send a queuePosition with 0 if it starts processing the request.

Controller methods should use ```Response::write``` and ```Response::end```  because headers have already been sent.
### Backend

```
import {MiddlewareConsumer, Module, NestModule} from "@nestjs/common";
import {Request} from "express";
import {
    WaitingRoomMiddleware,
    WaitingRoomOptions,
} from "./middleware/waiting-room.middleware.js";

@Module({
    providers: [
        {
            provide: WaitingRoomOptions,
            useFactory: () => new WaitingRoomOptions({
                getClientIdentifier: (request: Request): string => request.ip,
                maxClientRequests: parseInt(process.env.MAX_CLIENT_REQUESTS),
                maxProcessing: parseInt(process.env.MAX_PROCESSING),
                maxWaiting: parseInt(process.env.MAX_WAITING)
            })
        },
        LlamaService
    ],
    controllers: [
        ...
    ]
})
export class AppModule implements NestModule {
    public configure(consumer: MiddlewareConsumer): any {
        consumer.apply(WaitingRoomMiddleware).forRoutes(...);
    }
}
```

### Frontend example

```
function handleResponse(response: Response) {
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body!.getReader();

    const {value} = await reader.read();
    reader.releaseLock();

    const data = <WaitingRoomResponse|any>JSON.parse((new TextDecoder()).decode(value));
    if (data.queuePosition !== undefined) {
        /** do something with the queuePosition like visualisation */

        setTimeout(async (): Promise<void> => {
            if (!response.body!.locked) {
                this.handleResponse(response);
            }
        }, 100);

        return;
    }

    /** do something with the response data you were waiting for */
    ...
}

fetch(..., {
    ...
}).then(handleResponse);
```