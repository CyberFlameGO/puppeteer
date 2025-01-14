/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Protocol} from 'devtools-protocol';
import {CDPSession} from './Connection.js';
import {IsolatedWorld} from './IsolatedWorld.js';
import {JSHandle} from './JSHandle.js';
import {EvaluateFunc, HandleFor} from './types.js';
import {
  createJSHandle,
  getExceptionMessage,
  isString,
  valueFromRemoteObject,
} from './util.js';

/**
 * @public
 */
export const EVALUATION_SCRIPT_URL = 'pptr://__puppeteer_evaluation_script__';
const SOURCE_URL_REGEX = /^[\040\t]*\/\/[@#] sourceURL=\s*(\S*?)\s*$/m;

/**
 * Represents a context for JavaScript execution.
 *
 * @example
 * A {@link Page} can have several execution contexts:
 *
 * - Each {@link Frame} of a {@link Page | page} has a "default" execution
 *   context that is always created after frame is attached to DOM. This context
 *   is returned by the {@link Frame.executionContext} method.
 * - Each {@link https://developer.chrome.com/extensions | Chrome extensions}
 *   creates additional execution contexts to isolate their code.
 *
 * @remarks
 * By definition, each context is isolated from one another, however they are
 * all able to manipulate non-JavaScript resources (such as DOM).
 *
 * @remarks
 * Besides pages, execution contexts can be found in
 * {@link WebWorker | workers}.
 *
 * @internal
 */
export class ExecutionContext {
  /**
   * @internal
   */
  _client: CDPSession;
  /**
   * @internal
   */
  _world?: IsolatedWorld;
  /**
   * @internal
   */
  _contextId: number;
  /**
   * @internal
   */
  _contextName: string;

  /**
   * @internal
   */
  constructor(
    client: CDPSession,
    contextPayload: Protocol.Runtime.ExecutionContextDescription,
    world?: IsolatedWorld
  ) {
    this._client = client;
    this._world = world;
    this._contextId = contextPayload.id;
    this._contextName = contextPayload.name;
  }

  /**
   * Evaluates the given function.
   *
   * @example
   *
   * ```ts
   * const executionContext = await page.mainFrame().executionContext();
   * const result = await executionContext.evaluate(() => Promise.resolve(8 * 7))* ;
   * console.log(result); // prints "56"
   * ```
   *
   * @example
   * A string can also be passed in instead of a function:
   *
   * ```ts
   * console.log(await executionContext.evaluate('1 + 2')); // prints "3"
   * ```
   *
   * @example
   * Handles can also be passed as `args`. They resolve to their referenced object:
   *
   * ```ts
   * const oneHandle = await executionContext.evaluateHandle(() => 1);
   * const twoHandle = await executionContext.evaluateHandle(() => 2);
   * const result = await executionContext.evaluate(
   *   (a, b) => a + b,
   *   oneHandle,
   *   twoHandle
   * );
   * await oneHandle.dispose();
   * await twoHandle.dispose();
   * console.log(result); // prints '3'.
   * ```
   *
   * @param pageFunction - The function to evaluate.
   * @param args - Additional arguments to pass into the function.
   * @returns The result of evaluating the function. If the result is an object,
   * a vanilla object containing the serializable properties of the result is
   * returned.
   */
  async evaluate<
    Params extends unknown[],
    Func extends EvaluateFunc<Params> = EvaluateFunc<Params>
  >(
    pageFunction: Func | string,
    ...args: Params
  ): Promise<Awaited<ReturnType<Func>>> {
    return await this.#evaluate(true, pageFunction, ...args);
  }

  /**
   * Evaluates the given function.
   *
   * Unlike {@link ExecutionContext.evaluate | evaluate}, this method returns a
   * handle to the result of the function.
   *
   * This method may be better suited if the object cannot be serialized (e.g.
   * `Map`) and requires further manipulation.
   *
   * @example
   *
   * ```ts
   * const context = await page.mainFrame().executionContext();
   * const handle: JSHandle<typeof globalThis> = await context.evaluateHandle(
   *   () => Promise.resolve(self)
   * );
   * ```
   *
   * @example
   * A string can also be passed in instead of a function.
   *
   * ```ts
   * const handle: JSHandle<number> = await context.evaluateHandle('1 + 2');
   * ```
   *
   * @example
   * Handles can also be passed as `args`. They resolve to their referenced object:
   *
   * ```ts
   * const bodyHandle: ElementHandle<HTMLBodyElement> =
   *   await context.evaluateHandle(() => {
   *     return document.body;
   *   });
   * const stringHandle: JSHandle<string> = await context.evaluateHandle(
   *   body => body.innerHTML,
   *   body
   * );
   * console.log(await stringHandle.jsonValue()); // prints body's innerHTML
   * // Always dispose your garbage! :)
   * await bodyHandle.dispose();
   * await stringHandle.dispose();
   * ```
   *
   * @param pageFunction - The function to evaluate.
   * @param args - Additional arguments to pass into the function.
   * @returns A {@link JSHandle | handle} to the result of evaluating the
   * function. If the result is a `Node`, then this will return an
   * {@link ElementHandle | element handle}.
   */
  async evaluateHandle<
    Params extends unknown[],
    Func extends EvaluateFunc<Params> = EvaluateFunc<Params>
  >(
    pageFunction: Func | string,
    ...args: Params
  ): Promise<HandleFor<Awaited<ReturnType<Func>>>> {
    return this.#evaluate(false, pageFunction, ...args);
  }

  async #evaluate<
    Params extends unknown[],
    Func extends EvaluateFunc<Params> = EvaluateFunc<Params>
  >(
    returnByValue: true,
    pageFunction: Func | string,
    ...args: Params
  ): Promise<Awaited<ReturnType<Func>>>;
  async #evaluate<
    Params extends unknown[],
    Func extends EvaluateFunc<Params> = EvaluateFunc<Params>
  >(
    returnByValue: false,
    pageFunction: Func | string,
    ...args: Params
  ): Promise<HandleFor<Awaited<ReturnType<Func>>>>;
  async #evaluate<
    Params extends unknown[],
    Func extends EvaluateFunc<Params> = EvaluateFunc<Params>
  >(
    returnByValue: boolean,
    pageFunction: Func | string,
    ...args: Params
  ): Promise<HandleFor<Awaited<ReturnType<Func>>> | Awaited<ReturnType<Func>>> {
    const suffix = `//# sourceURL=${EVALUATION_SCRIPT_URL}`;

    if (isString(pageFunction)) {
      const contextId = this._contextId;
      const expression = pageFunction;
      const expressionWithSourceUrl = SOURCE_URL_REGEX.test(expression)
        ? expression
        : expression + '\n' + suffix;

      const {exceptionDetails, result: remoteObject} = await this._client
        .send('Runtime.evaluate', {
          expression: expressionWithSourceUrl,
          contextId,
          returnByValue,
          awaitPromise: true,
          userGesture: true,
        })
        .catch(rewriteError);

      if (exceptionDetails) {
        throw new Error(
          'Evaluation failed: ' + getExceptionMessage(exceptionDetails)
        );
      }

      return returnByValue
        ? valueFromRemoteObject(remoteObject)
        : createJSHandle(this, remoteObject);
    }

    const functionText = pageFunction.toString();

    /**
     * We remove the check for the ability for dynamic javascript to be
     * serializable, because the Workers runtime does not allow dynamic
     * javascript to be executed, as a security precaution. In the
     * future, we can consider the serialization check in the back end
     * but before the message gets to the remote browser.
     * try {
     * new Function('(' + functionText + ')');
     * } catch (error) {
     * // This means we might have a function shorthand. Try another
     * // time prefixing 'function '.
     * if (functionText.startsWith('async ')) {
     * functionText =
     * 'async function ' + functionText.substring('async '.length);
     * } else {
     * functionText = 'function ' + functionText;
     * }
     * try {
     * new Function('(' + functionText + ')');
     * } catch (error) {
     * // We tried hard to serialize, but there's a weird beast here.
     * throw new Error('Passed function is not well-serializable!');
     * }
     * }
     */
    let callFunctionOnPromise;
    try {
      callFunctionOnPromise = this._client.send('Runtime.callFunctionOn', {
        functionDeclaration: functionText + '\n' + suffix + '\n',
        executionContextId: this._contextId,
        arguments: args.map(convertArgument.bind(this)),
        returnByValue,
        awaitPromise: true,
        userGesture: true,
      });
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message.startsWith('Converting circular structure to JSON')
      ) {
        error.message += ' Recursive objects are not allowed.';
      }
      throw error;
    }
    const {exceptionDetails, result: remoteObject} =
      await callFunctionOnPromise.catch(rewriteError);
    if (exceptionDetails) {
      throw new Error(
        'Evaluation failed: ' + getExceptionMessage(exceptionDetails)
      );
    }
    return returnByValue
      ? valueFromRemoteObject(remoteObject)
      : createJSHandle(this, remoteObject);

    function convertArgument(
      this: ExecutionContext,
      arg: unknown
    ): Protocol.Runtime.CallArgument {
      if (typeof arg === 'bigint') {
        // eslint-disable-line valid-typeof
        return {unserializableValue: `${arg.toString()}n`};
      }
      if (Object.is(arg, -0)) {
        return {unserializableValue: '-0'};
      }
      if (Object.is(arg, Infinity)) {
        return {unserializableValue: 'Infinity'};
      }
      if (Object.is(arg, -Infinity)) {
        return {unserializableValue: '-Infinity'};
      }
      if (Object.is(arg, NaN)) {
        return {unserializableValue: 'NaN'};
      }
      const objectHandle = arg && arg instanceof JSHandle ? arg : null;
      if (objectHandle) {
        if (objectHandle.executionContext() !== this) {
          throw new Error(
            'JSHandles can be evaluated only in the context they were created!'
          );
        }
        if (objectHandle.disposed) {
          throw new Error('JSHandle is disposed!');
        }
        if (objectHandle.remoteObject().unserializableValue) {
          return {
            unserializableValue:
              objectHandle.remoteObject().unserializableValue,
          };
        }
        if (!objectHandle.remoteObject().objectId) {
          return {value: objectHandle.remoteObject().value};
        }
        return {objectId: objectHandle.remoteObject().objectId};
      }
      return {value: arg};
    }
  }
}

const rewriteError = (error: Error): Protocol.Runtime.EvaluateResponse => {
  if (error.message.includes('Object reference chain is too long')) {
    return {result: {type: 'undefined'}};
  }
  if (error.message.includes("Object couldn't be returned by value")) {
    return {result: {type: 'undefined'}};
  }

  if (
    error.message.endsWith('Cannot find context with specified id') ||
    error.message.endsWith('Inspected target navigated or closed')
  ) {
    throw new Error(
      'Execution context was destroyed, most likely because of a navigation.'
    );
  }
  throw error;
};
