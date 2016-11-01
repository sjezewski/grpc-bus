import { Subject } from 'rxjs/Subject';
import { Service } from './service';
import {
  IGBCallInfo,
  IGBServerMessage,
} from '../proto';

import * as _ from 'lodash';

// An ongoing call against a service.
export class Call {
  // Subject called when disposed.
  public disposed: Subject<Call> = new Subject<Call>();
  // Handle returned by a client-side streaming call.
  private streamHandle: any;
  private rpcMeta: any;

  public constructor(private service: Service,
                     private clientId: number,
                     private clientServiceId: number,
                     private callInfo: IGBCallInfo,
                     private send: (msg: IGBServerMessage) => void) {
  }

  public initCall() {
    if (!this.callInfo || !this.callInfo.method_id) {
      throw new Error('Call info, method ID must be given');
    }
    let args: any;
    if (this.callInfo.arguments && this.callInfo.arguments.length) {
      args = JSON.parse(this.callInfo.arguments);
      if (typeof args !== 'object' || args.constructor !== Object) {
        throw new TypeError('Arguments must be an object.');
      }
    }
    let rpcMeta = this.service.lookupMethod(this.callInfo.method_id);
    if (!rpcMeta) {
      throw new Error('Method ' + this.callInfo.method_id + ' not found.');
    }
    this.rpcMeta = rpcMeta;
    if (rpcMeta.className !== 'Service.RPCMethod') {
      throw new Error('Method ' +
                      this.callInfo.method_id +
                      ' is a ' +
                      rpcMeta.className +
                      ' not a Service.RPCMethod');
    }
    let camelMethod = _.camelCase(rpcMeta.name);
    if (!this.service.stub[camelMethod] || typeof this.service.stub[camelMethod] !== 'function') {
      throw new Error('Method ' + camelMethod + ' not defined by grpc.');
    }
    if (rpcMeta.requestStream && !rpcMeta.responseStream) {
      this.streamHandle = this.service.stub[camelMethod]((error: any, response: any) => {
        this.handleCallCallback(error, response);
      });
      // If they sent some args (shouldn't happen usually) send it off anyway
      if (args) {
        this.streamHandle.write(args);
      }
    } else if (rpcMeta.requestStream && rpcMeta.responseStream) {
      this.streamHandle = this.service.stub[camelMethod]();
      this.setCallHandlers(this.streamHandle);
    } else if (!rpcMeta.requestStream && rpcMeta.responseStream) {
      this.streamHandle = this.service.stub[camelMethod](args);
      this.setCallHandlers(this.streamHandle);
    } else if (!rpcMeta.requestStream && !rpcMeta.responseStream) {
      if (!args) {
        throw new Error('Method ' +
                        this.callInfo.method_id +
                        ' requires an argument object of type ' +
                        rpcMeta.requestName + '.');
      }
      this.service.stub[camelMethod](args, (error: any, response: any) => {
        this.handleCallCallback(error, response);
      });
    }
  }

  public write(msg: any) {
    if (!this.rpcMeta.requestStream ||
        !this.streamHandle ||
        typeof this.streamHandle['write'] !== 'function') {
      return;
    }
    this.streamHandle.write(msg);
  }

  public sendEnd() {
    if (!this.rpcMeta.requestStream ||
        !this.streamHandle ||
        typeof this.streamHandle['end'] !== 'function') {
      return;
    }
    this.streamHandle.end();
  }

  public dispose() {
    this.send({
      call_ended: {
        call_id: this.clientId,
        service_id: this.clientServiceId,
      },
    });
    if (this.streamHandle && typeof this.streamHandle['end'] === 'function') {
      this.streamHandle.end();
      this.streamHandle = null;
    }
    this.disposed.next(this);
  }

  private handleCallCallback(error: any, response: any) {
    if (error) {
      this.callEventHandler('error')(error);
    }
    if (response) {
      this.callEventHandler('data')(response);
    }
    this.dispose();
  }

  private setCallHandlers(streamHandle: any) {
    this.streamHandle.on('data', this.callEventHandler('data'));
    this.streamHandle.on('status', this.callEventHandler('status'));
    this.streamHandle.on('error', this.callEventHandler('error'));
    this.streamHandle.on('end', this.callEventHandler('end'));
  }

  private callEventHandler(eventId: string) {
    return (data: any) => {
      this.send({
        call_event: {
          service_id: this.clientServiceId,
          call_id: this.clientId,
          data: JSON.stringify(data),
          event: eventId,
        },
      });
    };
  }
}
