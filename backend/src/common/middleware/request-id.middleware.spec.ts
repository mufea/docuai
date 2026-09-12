import { Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  RequestWithId,
  getRequestId,
  requestIdMiddleware,
} from './request-id.middleware';

function createRequest(headerValue?: string): Request {
  return {
    header: (name: string) =>
      name === REQUEST_ID_HEADER ? headerValue : undefined,
  } as unknown as Request;
}

function createResponse() {
  const setHeader = jest.fn();
  return { res: { setHeader } as unknown as Response, setHeader };
}

describe('requestIdMiddleware', () => {
  it('generates a UUID when no header is provided', () => {
    const req = createRequest();
    const { res, setHeader } = createResponse();
    const next = jest.fn();

    requestIdMiddleware(req, res, next);

    const id = (req as RequestWithId).requestId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, id);
    expect(getRequestId(req)).toBe(id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps a well-formed incoming request ID', () => {
    const req = createRequest('trace_abc.123:1');
    const { res } = createResponse();

    requestIdMiddleware(req, res, jest.fn());

    expect(getRequestId(req)).toBe('trace_abc.123:1');
  });

  it('replaces malformed or oversized incoming request IDs', () => {
    const malformed = createRequest('has spaces');
    const oversized = createRequest('a'.repeat(200));
    const { res } = createResponse();

    requestIdMiddleware(malformed, res, jest.fn());
    requestIdMiddleware(oversized, res, jest.fn());

    expect(getRequestId(malformed)).not.toBe('has spaces');
    expect(getRequestId(oversized)).toHaveLength(36);
  });
});
