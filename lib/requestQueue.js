'use strict';

/**
 * @typedef {object} QueueJob
 * @property {() => Promise<unknown>} fn starts the request
 * @property {(value: unknown) => void} resolve resolves the caller's promise
 * @property {(reason: unknown) => void} reject rejects the caller's promise
 */

/**
 * Runs requests to the Tedee Bridge strictly one after another.
 *
 * The bridge serves one request at a time and answers further connections with
 * "503 Service Unavailable" (Bridge API 1.19: "do not open several connections in parallel").
 * Commands of the user (lock, unlock, pull) are put in front of background requests
 * (polling, PIN lists), so they never wait behind a long PIN list.
 */
class RequestQueue {
  /**
   * Creates an empty queue.
   */
  constructor() {
    /** @type {QueueJob[]} */
    this.high = [];
    /** @type {QueueJob[]} */
    this.normal = [];
    this.running = false;
  }

  /**
   * Adds a request to the queue.
   *
   * @template T
   * @param {() => Promise<T>} fn starts the request
   * @param {boolean} [priority] true: run before all waiting background requests
   * @returns {Promise<T>} result of fn
   */
  run(fn, priority) {
    return new Promise((resolve, reject) => {
      /** @type {QueueJob} */
      const job = {
        fn,
        resolve: (value) => resolve(/** @type {T} */ (value)),
        reject,
      };
      (priority ? this.high : this.normal).push(job);
      this.next();
    });
  }

  /**
   * Starts the next waiting request if none is running.
   */
  next() {
    if (this.running) {
      return;
    }
    const job = this.high.shift() || this.normal.shift();
    if (!job) {
      return;
    }
    this.running = true;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running = false;
        this.next();
      });
  }

  /**
   * Number of waiting (not yet started) requests.
   *
   * @returns {number} waiting requests
   */
  get size() {
    return this.high.length + this.normal.length;
  }
}

module.exports = { RequestQueue };
