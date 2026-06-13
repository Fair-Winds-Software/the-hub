// Authorized by HUB-79 — Global error handler plugin; slot 2 in app.ts plugin chain
import fp from 'fastify-plugin';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { AppError } from '../errors/AppError.js';

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.statusCode, message: error.message },
      });
    }

    // Fastify schema validation errors carry a `validation` array
    if (error.validation) {
      request.log.warn({ err: error }, 'validation error');
      return reply.status(400).send({
        error: { code: 400, message: `Validation error: ${error.message}` },
      });
    }

    // Unexpected error — log everything internally; return safe 500 to caller
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 500, message: 'Internal server error' },
    });
  });

  fastify.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      error: { code: 404, message: 'Route not found' },
    });
  });
};

// fp() escapes Fastify's plugin encapsulation so error/notFound handlers
// apply to the entire application, not just this plugin's scope.
export default fp(errorHandlerPlugin);
