"""One student prompt, pinned tokenizer, serialization and target contract for v2."""
import hashlib
import json
from pathlib import Path

ASSETS = Path(__file__).with_name("query-tokenizer")
CONTRACT = json.loads((ASSETS / "contract.json").read_text())
MODEL, REVISION, SYSTEM = (CONTRACT[key] for key in ("model", "revision", "system"))


def serialize_conversation(conversation):
    return json.dumps({"history": conversation["history"], "currentRequest": conversation["currentRequest"]},
                      ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def validate_conversation(conversation, tokenizer):
    if not isinstance(conversation, dict) or set(conversation) != {"history", "currentRequest"} or \
            not isinstance(conversation["currentRequest"], str) or not conversation["currentRequest"] or \
            not isinstance(conversation["history"], list):
        raise ValueError("Invalid prepared conversation")
    for message in conversation["history"]:
        if not isinstance(message, dict) or set(message) != {"role", "content"} or \
                message["role"] not in ("user", "assistant") or not isinstance(message["content"], str):
            raise ValueError("Invalid prepared conversation history")
    serialized = serialize_conversation(conversation)
    if len(serialized.encode("utf-8")) > CONTRACT["conversationBytes"] or \
            len(tokenizer.encode(serialized, add_special_tokens=False)) > CONTRACT["conversationTokens"]:
        raise ValueError("Prepared conversation exceeds shared window")


def validate_query_pair(value):
    if not isinstance(value, dict) or set(value) != {"lex", "vec"} or \
            any(not isinstance(value[key], str) or not value[key].strip() for key in ("lex", "vec")):
        raise ValueError("Expected exactly one nonempty lex/vec query pair")
    return {key: value[key].strip() for key in ("lex", "vec")}


def student_messages(conversation):
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": "<conversation_data>\n" + serialize_conversation(conversation) + "\n</conversation_data>"}]


def student_prompt_tokens(tokenizer, conversation):
    validate_conversation(conversation, tokenizer)
    # Transformers 5 may return BatchEncoding for tokenize=True. Encode the
    # rendered template explicitly, exactly as dataset preparation does.
    text = tokenizer.apply_chat_template(student_messages(conversation), tokenize=False, add_generation_prompt=True)
    return tokenizer.encode(text, add_special_tokens=False)


def load_tokenizer():
    from transformers import AutoTokenizer
    return AutoTokenizer.from_pretrained(ASSETS, local_files_only=True, trust_remote_code=False)


def verify_model_tokenizer(root):
    # The model package must carry the exact tokenizer/template used for collection.
    for name in ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja"):
        if hashlib.sha256((root / name).read_bytes()).digest() != hashlib.sha256((ASSETS / name).read_bytes()).digest():
            raise ValueError("Incompatible model tokenizer or chat template")
