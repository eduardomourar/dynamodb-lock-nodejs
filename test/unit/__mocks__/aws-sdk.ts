export const promiseResponse = jest.fn().mockReturnValue(Promise.resolve(true));
const getFn = jest.fn().mockImplementation(() => ({promise: promiseResponse}));
const putFn = jest.fn().mockImplementation(() => ({promise: promiseResponse}));
const updateFn = jest.fn().mockImplementation(() => ({promise: promiseResponse}));
const deleteFn = jest.fn().mockImplementation(() => ({promise: promiseResponse}));

export class DocumentClient {
    get = getFn;
    put = putFn;
    update = updateFn;
    delete = deleteFn;
}
