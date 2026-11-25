"""Exercise production middleware directly; no production network or data."""
import asyncio
from app.core.traffic import TokenBuckets, TrafficGuard


def test_token_buckets_refill_and_bound_memory():
    t = [0.0]
    limiter = TokenBuckets(max_keys=2, clock=lambda: t[0])
    assert limiter.take('a', 60, 2) == 0
    assert limiter.take('a', 60, 2) == 0
    assert limiter.take('a', 60, 2) == 1
    t[0] += 1
    assert limiter.take('a', 60, 2) == 0
    limiter.take('b', 60, 2)
    limiter.take('c', 60, 2)
    assert len(limiter.buckets) == 2


def test_overload_reserves_write_capacity_and_recovers():
    async def scenario():
        release = asyncio.Event()
        entered = asyncio.Queue()
        async def endpoint(scope, receive, send):
            await entered.put(scope['method'])
            await release.wait()
            await send({'type':'http.response.start','status':200,'headers':[]})
            await send({'type':'http.response.body','body':b'ok'})
        guard = TrafficGuard(endpoint, max_active=3)
        async def req(method='GET', path='/api/test'):
            events=[]
            async def receive(): return {'type':'http.request','body':b''}
            async def send(event): events.append(event)
            await guard({'type':'http','path':path,'method':method,'client':('127.0.0.1',1)},receive,send)
            return events[0]
        first = asyncio.create_task(req()); await entered.get()
        second = asyncio.create_task(req()); await entered.get()
        blocked = await req()
        assert blocked['status']==503 and (b'retry-after',b'3') in blocked['headers']
        write = asyncio.create_task(req('POST')); assert await entered.get()=='POST'
        assert (await req('POST'))['status']==503
        release.set()
        assert all(x['status']==200 for x in await asyncio.gather(first,second,write))
        assert guard.active==guard.active_reads==0
        assert (await req())['status']==200
    asyncio.run(scenario())


def test_ip_limit_ignores_untrusted_forwarded_headers_and_static_routes():
    async def scenario():
        async def endpoint(scope,receive,send):
            await send({'type':'http.response.start','status':200,'headers':[]})
            await send({'type':'http.response.body','body':b''})
        guard=TrafficGuard(endpoint,ip_per_minute=1,ip_burst=1)
        async def req(path, forwarded):
            events=[]
            async def send(event): events.append(event)
            async def receive(): return {'type':'http.request','body':b''}
            await guard({'type':'http','method':'GET','path':path,'client':('127.0.0.1',1),'headers':[(b'x-forwarded-for',forwarded)]},receive,send)
            return events[0]
        assert (await req('/api/test',b'1.2.3.4'))['status']==200
        limited=await req('/api/test',b'9.8.7.6')
        assert limited['status']==429 and b'retry-after' in dict(limited['headers'])
        assert (await req('/assets/test.js',b'9.8.7.6'))['status']==200
    asyncio.run(scenario())
