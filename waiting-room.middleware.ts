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
    getClientIdentifier(request: Request) {
        return request.ip;
    },
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

@Injectable()
export class WaitingRoomMiddleware implements NestMiddleware {
    private readonly clients: Map<string, Set<number>> = new Map();
    private readonly waiting: Set<number> = new Set();
    private readonly processing: Set<number> = new Set();

    public constructor(private readonly options: WaitingRoomOptions) {
    }

    public async use(request: Request, response: Response, next: NextFunction): Promise<void> {
        const clientId: string = this.options.getClientIdentifier(request);
        const requestId: number = Math.ceil(Math.random() * 10 ** 8);

        const requestSet: Set<number> = this.clients.get(clientId) ?? new Set<number>();

        if (this.waiting.size >= this.options.maxWaiting ||
            requestSet.size >= this.options.maxClientRequests
        ) {
            throw new HttpException(this.options.errors.ERROR_REQUEST_LIMIT, HttpStatus.TOO_MANY_REQUESTS);
        }

        requestSet.add(requestId);
        if (!this.clients.has(clientId)) {
            this.clients.set(clientId, requestSet);
        }

        if (this.processing.size >= this.options.maxProcessing) {
            this.waiting.add(requestId);
            const proceed: boolean = await this.waitForQueue(
                requestId,
                this.waiting.size + 1,
                request,
                response
            );
            this.waiting.delete(requestId);

            if (!proceed) {
                requestSet.delete(requestId);

                return;
            }
        }

        this.processing.add(requestId);

        (<WaitingRoomRequest>request).requestQueueMiddleware = {
            clientIdentifier: clientId,
            requestIdentifier: requestId,
            finishProcessing: this.finishProcessing.bind(this, requestSet, requestId, clientId)
        };

        next();
    }

    private waitForQueue(
        requestId: number,
        queuePosition: number,
        request: Request,
        response: Response
    ): Promise<boolean> {
        return new Promise((resolve): void => {
            if (request.socket.closed) {
                resolve(false);
            }

            const newPosition: number = Array.from(this.waiting).indexOf(requestId) + 1;
            if (queuePosition !== newPosition) {
                queuePosition = newPosition;

                this.sendQueueResponseKeepAlive(queuePosition, response);
            }

            if (queuePosition === 1 && this.processing.size < this.options.maxProcessing) {
                this.sendQueueResponseKeepAlive(0, response);
                resolve(true);

                return;
            }

            setTimeout(
                async (): Promise<void> => {
                    resolve(await this.waitForQueue(requestId, queuePosition, request, response));
                },
                this.options.msWaitingCheckInterval
            );
        });
    }

    private sendQueueResponseKeepAlive(queuePosition: number, response: Response): void {
        if (!response.headersSent) {
            for (const key in this.options.headers) {
                response.setHeader(key, this.options.headers[key]);
            }
        }

        response.write(JSON.stringify(<WaitingRoomResponseData>{queuePosition}));
    }

    private finishProcessing(requestSet: Set<number>, requestId: number, clientId: string): void {
        this.processing.delete(requestId);
        requestSet.delete(requestId);

        if (requestSet.size === 0) {
            this.clients.delete(clientId);
        }
    }
}