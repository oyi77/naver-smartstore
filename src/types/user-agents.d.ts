declare module 'user-agents' {
    export default class UserAgent {
        constructor(options?: any);
        toString(): string;
        data: any;
    }
}
