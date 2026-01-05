export interface ApiResponse<T> {
    status: 'success' | 'error';
    data?: T;
    error?: {
        code: number;
        message: string;
        details?: any;
    };
}

export const successResponse = <T>(data: T): ApiResponse<T> => {
    return {
        status: 'success',
        data,
    };
};

export const errorResponse = (message: string, code: number = 500, details?: any): ApiResponse<null> => {
    return {
        status: 'error',
        error: {
            code,
            message,
            details,
        },
    };
};
