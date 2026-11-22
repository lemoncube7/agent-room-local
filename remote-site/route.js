import {env} from 'cloudflare:workers';
import {handleRoom} from './handler.mjs';

export const dynamic='force-dynamic';
export const GET=request=>handleRoom(request,env);
export const POST=request=>handleRoom(request,env);
