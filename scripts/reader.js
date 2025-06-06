export class Reader {
    #i = 0;
    #maxBytes = 0;
    #availableBytes;
    #done = false;
    /**
     * @type{()=>{} | null} Called when bytes are available.
     * There can't be more than 1 awaiter
     */
    #awaiter = null;

    /**
     * @returns {number} Content length if available, or an estimante
     */
    get contentLength() {
        return this.#availableBytes.length;
    }

    /**
     * @returns {number} Number or bytes read
     */
    get readBytes() {
        return this.#i;
    }
    /**
     * @param {Uint8Array|null} [prefix] Bytes to prefix, if any
     */
    constructor(req, prefix = null) {
        const prefixLength = prefix?.length ?? 0;
        this.#availableBytes = new Uint8Array(
            Number(
                req.headers?.get('Content-Length') ||
                    req.headers?.get('X-Content-Length') ||
                    1024
            ) + prefixLength
        );

        if (prefix) {
            this.#appendBytes(prefix);
        }

        const stream = req.body.getReader();
        (async () => {
            while (true) {
                const { done, value } = await stream.read();
                if (value) {
                    this.#appendBytes(value);
                }
                if (done) {
                    this.#done = true;
                    if (this.#awaiter) this.#awaiter();
                    break;
                }
            }
        })();
    }

    #resizeArray(newLength) {
        if (newLength <= this.#availableBytes.length) {
            throw new Error(
                'New length must be greater than the current length.'
            );
        }

        const newArray = new Uint8Array(newLength);
        newArray.set(this.#availableBytes);
        this.#availableBytes = newArray;
    }

    #appendBytes(bytes) {
        // If we have content-length, there should never be a need to
        // resize
        if (bytes.length + this.#maxBytes > this.#availableBytes.length) {
            this.#resizeArray((bytes.length + this.#maxBytes) * 2);
        }

        this.#availableBytes.set(bytes, this.#maxBytes);
        this.#maxBytes += bytes.length;
        // Notify the awaiter if there is one
        if (this.#awaiter) this.#awaiter();
    }

    /**
     * @param{number} byteLength
     * @returns {Promise<Uint8Array | null>} bytes or null if there are no more bytes
     */
    async read(byteLength) {
        if (this.#awaiter) throw new Error('Called read more than once');
        while (true) {
            if (this.#maxBytes - this.#i >= byteLength) {
                this.#awaiter = null;
                // We have enough bytes to respond
                const res = this.#availableBytes.subarray(
                    this.#i,
                    this.#i + byteLength
                );
                this.#i += byteLength;
                return res;
            }

            // There are no more bytes to await, so we can return null
            if (this.#done) {
                this.#awaiter = null;
                return null;
            }
            // If we didn't respond, wait for the next batch of bytes, then try again
            await new Promise((res) => {
                this.#awaiter = res;
            });
        }
    }

    /**
     * Discards bytes, but updates `readBytes` in real time instead of the end
     * @param {number} byteLength
     */
    async discard(byteLength) {
        if (this.#awaiter) throw new Error('Reading more than once');
        while (true) {
            const discaredBytes = Math.min(
                this.#maxBytes - this.#i,
                byteLength
            );
            this.#i += discaredBytes;
            byteLength -= discaredBytes;
            if (byteLength === 0 || this.#done) {
                this.#awaiter = null;
                return;
            }
            // If we didn't respond, wait for the next batch of bytes, then try again
            await new Promise((res) => {
                this.#awaiter = res;
            });
        }
    }

    getReadBuffer() {
        return this.#availableBytes.subarray(0, this.#i);
    }

    isBusy() {
        return !!this.#awaiter;
    }
}
