import {HttpException, HttpStatus, Injectable, NestMiddleware} from "@nestjs/common";
import {NextFunction, Request, Response} from "express";

export interface WaitingRoomRequest extends Request {
    requestQueueMiddleware: {
        clientIdentifier: string;
        requestIdentifier: number;
        finishProcessing: () => void;
    };
}

export interface WaitingRoomResponseData {
    queuePosition: number;
}

export const WaitingRoomOptionsDefaults: Partial<WaitingRoomOptions> = {
    getClientIdentifier: (request: Request) => request.ip,
    maxClientRequests: 3,
    maxProcessing: 1,
    maxWaiting: 10,
    msWaitingCheckInterval: 100,
    headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked'
    },
    errors: {
        ERROR_REQUEST_LIMIT: 'request limit reached'
    }
};

export class WaitingRoomOptions {
    public readonly getClientIdentifier: (request: Request) => string;
    public readonly maxClientRequests: number;
    public readonly maxProcessing: number;
    public readonly maxWaiting: number;
    public readonly msWaitingCheckInterval: number;
    public readonly headers: Record<string, string>;
    public readonly errors: { ERROR_REQUEST_LIMIT: string; };

    public constructor(options: Partial<WaitingRoomOptions> = WaitingRoomOptionsDefaults) {
        for (let property in WaitingRoomOptionsDefaults) {
            this[property] = options[property] ?? WaitingRoomOptionsDefaults[property];
        }
    }
}

interface ClientMapData {
    request: Request,
    response: Response,
    next: NextFunction
}

type ClientMap = Map<number, ClientMapData>;

@Injectable()
export class WaitingRoomMiddleware implements NestMiddleware {
    private readonly clients: Map<string, ClientMap> = new Map();
    private readonly waiting: Map<number, string> = new Map();
    private readonly processing: Map<number, string> = new Map();

    public constructor(private readonly options: WaitingRoomOptions) {
    }

    public use(request: Request, response: Response, next: NextFunction): void {
        const clientId: string = this.options.getClientIdentifier(request);
        const requestId: number = Math.ceil(Math.random() * 10 ** 8);

        const clientMap: ClientMap = this.clients.get(clientId) ?? new Map();

        if (this.waiting.size >= this.options.maxWaiting ||
            clientMap.size >= this.options.maxClientRequests
        ) {
            throw new HttpException(this.options.errors.ERROR_REQUEST_LIMIT, HttpStatus.TOO_MANY_REQUESTS);
        }

        const clientMapData: ClientMapData = {request, response, next};
        clientMap.set(requestId, clientMapData);
        if (!this.clients.has(clientId)) {
            this.clients.set(clientId, clientMap);
        }

        if (this.processing.size >= this.options.maxProcessing) {
            this.waiting.set(requestId, clientId);
            this.sendWaitingRoomResponse(clientMapData, this.waiting.size);

            return;
        }

        this.startProcessing(clientMap, requestId, clientId, next);
    }

    private startProcessing(clientMap: ClientMap, requestId: number, clientId: string, next: NextFunction): void {
        this.processing.set(requestId, clientId);

        (<WaitingRoomRequest>clientMap.get(requestId).request).requestQueueMiddleware = {
            clientIdentifier: clientId,
            requestIdentifier: requestId,
            finishProcessing: this.finishProcessing.bind(this, clientMap, requestId, clientId)
        };

        next();
    }

    private finishProcessing(clientMap: ClientMap, requestId: number, clientId: string): void {
        this.processing.delete(requestId);
        clientMap.delete(requestId);

        if (clientMap.size === 0) {
            this.clients.delete(clientId);
        }

        this.executeNextWaiting();
    }

    private executeNextWaiting(): void {
        const iteratorResult: IteratorResult<number> = this.waiting.keys().next();
        if (!iteratorResult.done) {
            const requestId: number = iteratorResult.value;
            const clientId: string = this.waiting.get(requestId);
            const clientMap: ClientMap = this.clients.get(clientId);
            const clientMapData: ClientMapData = clientMap.get(requestId);

            this.waiting.delete(requestId);
            this.sendAllWaitingRoomResponse();

            if (clientMapData.request.socket.closed) {
                this.finishProcessing(clientMap, requestId, clientId);

                return;
            }

            this.sendWaitingRoomResponse(clientMapData, 0);
            this.startProcessing(clientMap, requestId, clientId, clientMapData.next)
        }
    }

    private sendAllWaitingRoomResponse(): void {
        Array.from(this.waiting.keys()).forEach(
            (requestId: number, queuePosition: number): void => {
                queuePosition++;

                const clientId: string = this.waiting.get(requestId);
                const clientMapData: ClientMapData = this.clients.get(clientId).get(requestId);

                this.sendWaitingRoomResponse(clientMapData, queuePosition);
            }
        );
    }

    private sendWaitingRoomResponse(clientMapData: ClientMapData, queuePosition: number): void {
        if (!clientMapData.response.headersSent) {
            for (const key in this.options.headers) {
                clientMapData.response.setHeader(key, this.options.headers[key]);
            }
        }

        clientMapData.response.write(JSON.stringify(<WaitingRoomResponseData>{queuePosition}));
    }
}

