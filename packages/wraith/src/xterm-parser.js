/** Copyright (c) 2018 The xterm.js authors. All rights reserved. @license MIT
 * Generated derivative of EscapeSequenceParser.ts (c50c159ec6fb209a1be4f1fb4266c84865e4460d8b82f54e3d429b760386e4ef). */
const NON_ASCII_PRINTABLE = 0xa0;
export function installParameterBatching(terminal) {
    const parser = terminal?._core?._inputHandler?._parser;
    const p = parser?._params;
    if (typeof parser?.parse !== 'function' || !(p?.params instanceof Int32Array) ||
        typeof p.addParam !== 'function' || typeof p.addSubParam !== 'function' ||
        typeof p.addDigit !== 'function' || typeof p._digitIsSub !== 'boolean' ||
        typeof p._rejectDigits !== 'boolean' || !parser._parseStack ||
        !(parser._transitions?.table instanceof Uint8Array) ||
        parser._transitions.table[0x1b] !== 0xb1 ||
        parser._transitions.table[0x15b] !== 0xb3)
        return false;
    parser.parse = fastParse;
    return true;
}
function fastParse(data, length, promiseResult) {
    let code = 0;
    let transition = 0;
    let start = 0;
    let handlerResult;
    // resume from async handler
    if (this._parseStack.state) {
        // allow sync parser reset even in continuation mode
        // Note: can be used to recover parser from improper continuation error below
        if (this._parseStack.state === 2 /* ParserStackType.RESET */) {
            this._parseStack.state = 0 /* ParserStackType.NONE */;
            start = this._parseStack.chunkPos + 1; // continue with next codepoint in GROUND
        }
        else {
            if (promiseResult === undefined || this._parseStack.state === 1 /* ParserStackType.FAIL */) {
                /**
                 * Reject further parsing on improper continuation after pausing. This is a really bad
                 * condition with screwed up execution order and prolly messed up terminal state,
                 * therefore we exit hard with an exception and reject any further parsing.
                 *
                 * Note: With `Terminal.write` usage this exception should never occur, as the top level
                 * calls are guaranteed to handle async conditions properly. If you ever encounter this
                 * exception in your terminal integration it indicates, that you injected data chunks to
                 * `InputHandler.parse` or `EscapeSequenceParser.parse` synchronously without waiting for
                 * continuation of a running async handler.
                 *
                 * It is possible to get rid of this error by calling `reset`. But dont rely on that, as
                 * the pending async handler still might mess up the terminal later. Instead fix the
                 * faulty async handling, so this error will not be thrown anymore.
                 */
                this._parseStack.state = 1 /* ParserStackType.FAIL */;
                throw new Error('improper continuation due to previous async handler, giving up parsing');
            }
            // we have to resume the old handler loop if:
            // - return value of the promise was `false`
            // - handlers are not exhausted yet
            const handlers = this._parseStack.handlers;
            let handlerPos = this._parseStack.handlerPos - 1;
            switch (this._parseStack.state) {
                case 3 /* ParserStackType.CSI */:
                    if (promiseResult === false && handlerPos > -1) {
                        for (; handlerPos >= 0; handlerPos--) {
                            handlerResult = handlers[handlerPos](this._params);
                            if (handlerResult === true) {
                                break;
                            }
                            else if (handlerResult instanceof Promise) {
                                this._parseStack.handlerPos = handlerPos;
                                return handlerResult;
                            }
                        }
                    }
                    this._parseStack.handlers = [];
                    break;
                case 4 /* ParserStackType.ESC */:
                    if (promiseResult === false && handlerPos > -1) {
                        for (; handlerPos >= 0; handlerPos--) {
                            handlerResult = handlers[handlerPos]();
                            if (handlerResult === true) {
                                break;
                            }
                            else if (handlerResult instanceof Promise) {
                                this._parseStack.handlerPos = handlerPos;
                                return handlerResult;
                            }
                        }
                    }
                    this._parseStack.handlers = [];
                    break;
                case 6 /* ParserStackType.DCS */:
                    code = data[this._parseStack.chunkPos];
                    handlerResult = this._dcsParser.unhook(code !== 0x18 && code !== 0x1a, promiseResult);
                    if (handlerResult) {
                        return handlerResult;
                    }
                    if (code === 0x1b)
                        this._parseStack.transition |= 1 /* ParserState.ESCAPE */;
                    this._params.reset();
                    this._params.addParam(0); // ZDM
                    this._collect = 0;
                    break;
                case 5 /* ParserStackType.OSC */:
                    code = data[this._parseStack.chunkPos];
                    handlerResult = this._oscParser.end(code !== 0x18 && code !== 0x1a, promiseResult);
                    if (handlerResult) {
                        return handlerResult;
                    }
                    if (code === 0x1b)
                        this._parseStack.transition |= 1 /* ParserState.ESCAPE */;
                    this._params.reset();
                    this._params.addParam(0); // ZDM
                    this._collect = 0;
                    break;
            }
            // cleanup before continuing with the main sync loop
            this._parseStack.state = 0 /* ParserStackType.NONE */;
            start = this._parseStack.chunkPos + 1;
            this.precedingJoinState = 0;
            this.currentState = this._parseStack.transition & 15 /* TableAccess.TRANSITION_STATE_MASK */;
        }
    }
    // continue with main sync loop
    // process input string
    for (let i = start; i < length; ++i) {
        code = data[i];
        // ESC [ has two consecutive CLEAR actions in the pinned table. With
        // both introducer bytes present in GROUND, one reset is equivalent. Keep
        // the actual CSI parameter parsing and dispatch (including async hooks)
        // in the original loop. Incomplete introducers use upstream transitions.
        if (code === 0x1b && this.currentState === 0 /* ParserState.GROUND */ &&
            i + 2 < length && data[i + 1] === 0x5b) {
            this._params.reset();
            this._params.addParam(0);
            this._collect = 0;
            this.currentState = 3 /* ParserState.CSI_ENTRY */;
            i += 2;
            code = data[i];
        }
        // normal transition & action lookup
        transition = this._transitions.table[this.currentState << 8 /* TableAccess.INDEX_STATE_SHIFT */ | (code < 0xa0 ? code : NON_ASCII_PRINTABLE)];
        switch (transition >> 4 /* TableAccess.TRANSITION_ACTION_SHIFT */) {
            case 2 /* ParserAction.PRINT */:
                // read ahead with loop unrolling
                // Note: 0x20 (SP) is included, 0x7F (DEL) is excluded
                for (let j = i + 1;; ++j) {
                    if (j >= length || (code = data[j]) < 0x20 || (code > 0x7e && code < NON_ASCII_PRINTABLE)) {
                        this._printHandler(data, i, j);
                        i = j - 1;
                        break;
                    }
                    if (++j >= length || (code = data[j]) < 0x20 || (code > 0x7e && code < NON_ASCII_PRINTABLE)) {
                        this._printHandler(data, i, j);
                        i = j - 1;
                        break;
                    }
                    if (++j >= length || (code = data[j]) < 0x20 || (code > 0x7e && code < NON_ASCII_PRINTABLE)) {
                        this._printHandler(data, i, j);
                        i = j - 1;
                        break;
                    }
                    if (++j >= length || (code = data[j]) < 0x20 || (code > 0x7e && code < NON_ASCII_PRINTABLE)) {
                        this._printHandler(data, i, j);
                        i = j - 1;
                        break;
                    }
                }
                break;
            case 3 /* ParserAction.EXECUTE */:
                if (this._executeHandlers[code])
                    this._executeHandlers[code]();
                else
                    this._executeHandlerFb(code);
                this.precedingJoinState = 0;
                break;
            case 0 /* ParserAction.IGNORE */:
                break;
            case 1 /* ParserAction.ERROR */:
                const inject = this._errorHandler({
                    position: i,
                    code,
                    currentState: this.currentState,
                    collect: this._collect,
                    params: this._params,
                    abort: false
                });
                if (inject.abort)
                    return;
                // inject values: currently not implemented
                break;
            case 7 /* ParserAction.CSI_DISPATCH */:
                // Trigger CSI Handler
                const handlers = this._csiHandlers[this._collect << 8 | code];
                let j = handlers ? handlers.length - 1 : -1;
                for (; j >= 0; j--) {
                    // true means success and to stop bubbling
                    // a promise indicates an async handler that needs to finish before progressing
                    handlerResult = handlers[j](this._params);
                    if (handlerResult === true) {
                        break;
                    }
                    else if (handlerResult instanceof Promise) {
                        this._preserveStack(3 /* ParserStackType.CSI */, handlers, j, transition, i);
                        return handlerResult;
                    }
                }
                if (j < 0) {
                    this._csiHandlerFb(this._collect << 8 | code, this._params);
                }
                this.precedingJoinState = 0;
                break;
            case 8 /* ParserAction.PARAM */: {
                const p = this._params;
                // A colon at the first position must enter the upstream subparam path.
                if (code !== 0x3a && !p._digitIsSub && !p._rejectDigits && p.length) {
                    const store = p.params;
                    let index = p.length - 1;
                    let value = store[index];
                    do {
                        if (code === 0x3b) {
                            store[index] = value;
                            p.addParam(0);
                            if (p._rejectDigits)
                                break;
                            index++;
                            value = 0;
                        }
                        else {
                            value = value * 10 + code - 48;
                            if (value > 0x7fffffff)
                                value = 0x7fffffff;
                        }
                    } while (++i < length && (code = data[i]) > 0x2f && code < 0x3c && code !== 0x3a);
                    store[index] = value;
                    if (i === length || code < 0x30 || code > 0x3b) {
                        i--;
                        break;
                    }
                }
                do {
                    switch (code) {
                        case 0x3b:
                            p.addParam(0);
                            break;
                        case 0x3a:
                            p.addSubParam(-1);
                            break;
                        default: p.addDigit(code - 48);
                    }
                } while (++i < length && (code = data[i]) > 0x2f && code < 0x3c);
                i--;
                break;
            }
            case 9 /* ParserAction.COLLECT */:
                this._collect <<= 8;
                this._collect |= code;
                break;
            case 10 /* ParserAction.ESC_DISPATCH */:
                const handlersEsc = this._escHandlers[this._collect << 8 | code];
                let jj = handlersEsc ? handlersEsc.length - 1 : -1;
                for (; jj >= 0; jj--) {
                    // true means success and to stop bubbling
                    // a promise indicates an async handler that needs to finish before progressing
                    handlerResult = handlersEsc[jj]();
                    if (handlerResult === true) {
                        break;
                    }
                    else if (handlerResult instanceof Promise) {
                        this._preserveStack(4 /* ParserStackType.ESC */, handlersEsc, jj, transition, i);
                        return handlerResult;
                    }
                }
                if (jj < 0) {
                    this._escHandlerFb(this._collect << 8 | code);
                }
                this.precedingJoinState = 0;
                break;
            case 11 /* ParserAction.CLEAR */:
                this._params.reset();
                this._params.addParam(0); // ZDM
                this._collect = 0;
                break;
            case 12 /* ParserAction.DCS_HOOK */:
                this._dcsParser.hook(this._collect << 8 | code, this._params);
                break;
            case 13 /* ParserAction.DCS_PUT */:
                // inner loop - exit DCS_PUT: 0x18, 0x1a, 0x1b, 0x7f, 0x80 - 0x9f
                // unhook triggered by: 0x1b, 0x9c (success) and 0x18, 0x1a (abort)
                for (let j = i + 1;; ++j) {
                    if (j >= length || (code = data[j]) === 0x18 || code === 0x1a || code === 0x1b || (code > 0x7f && code < NON_ASCII_PRINTABLE)) {
                        this._dcsParser.put(data, i, j);
                        i = j - 1;
                        break;
                    }
                }
                break;
            case 14 /* ParserAction.DCS_UNHOOK */:
                handlerResult = this._dcsParser.unhook(code !== 0x18 && code !== 0x1a);
                if (handlerResult) {
                    this._preserveStack(6 /* ParserStackType.DCS */, [], 0, transition, i);
                    return handlerResult;
                }
                if (code === 0x1b)
                    transition |= 1 /* ParserState.ESCAPE */;
                this._params.reset();
                this._params.addParam(0); // ZDM
                this._collect = 0;
                this.precedingJoinState = 0;
                break;
            case 4 /* ParserAction.OSC_START */:
                this._oscParser.start();
                break;
            case 5 /* ParserAction.OSC_PUT */:
                // inner loop: 0x20 (SP) included, 0x7F (DEL) included
                for (let j = i + 1;; j++) {
                    if (j >= length || (code = data[j]) < 0x20 || (code > 0x7f && code < NON_ASCII_PRINTABLE)) {
                        this._oscParser.put(data, i, j);
                        i = j - 1;
                        break;
                    }
                }
                break;
            case 6 /* ParserAction.OSC_END */:
                handlerResult = this._oscParser.end(code !== 0x18 && code !== 0x1a);
                if (handlerResult) {
                    this._preserveStack(5 /* ParserStackType.OSC */, [], 0, transition, i);
                    return handlerResult;
                }
                if (code === 0x1b)
                    transition |= 1 /* ParserState.ESCAPE */;
                this._params.reset();
                this._params.addParam(0); // ZDM
                this._collect = 0;
                this.precedingJoinState = 0;
                break;
        }
        this.currentState = transition & 15 /* TableAccess.TRANSITION_STATE_MASK */;
    }
}
