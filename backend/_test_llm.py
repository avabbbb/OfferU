import asyncio
import sys
sys.path.insert(0, ".")
from app.agents.llm import _get_client, chat_completion

async def main():
    try:
        client, model = _get_client()
        print(f"client base_url: {client.base_url}")
        print(f"client api_key set: {bool(client.api_key)}")
        # Check the http_client's trust_env
        hc = getattr(client, "_client", None)
        print(f"http_client type: {type(hc).__name__ if hc else 'None'}")
    except Exception as e:
        print(f"_get_client FAILED: {type(e).__name__}: {e}")
        return

    print("\n--- calling chat_completion ---")
    try:
        result = await chat_completion(
            messages=[{"role": "user", "content": "说'你好'两个字"}],
            temperature=0,
            max_tokens=20,
        )
        print(f"RESULT: {result!r}")
    except Exception as e:
        print(f"CALL FAILED: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()

asyncio.run(main())
