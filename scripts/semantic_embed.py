"""Bounded stdin/stdout CPU worker; never downloads or imports model-defined code."""
import os
import sys

os.environ.update(CUDA_VISIBLE_DEVICES="-1", HIP_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1",
                  TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                  HF_HUB_DISABLE_PROGRESS_BARS="1", TOKENIZERS_PARALLELISM="false")
sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import math
import socket
from pathlib import Path


def deny_network(*_args, **_kwargs):
    raise OSError("SEMANTIC_NETWORK_DISABLED")


socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--identity", required=True)
    arguments = parser.parse_args()
    model_path = Path(arguments.model).resolve(strict=True)
    if str(model_path).startswith(('\\\\', '//')) or not model_path.is_dir():
        raise ValueError("SEMANTIC_MODEL_INCOMPLETE")
    key_files = ["config.json", "tokenizer.json", "tokenizer_config.json", "sentence_bert_config.json",
                 "1_Pooling/config.json", "model.safetensors"]
    digest = hashlib.sha256(b"bert-mean-l2-v1\0")
    for name in key_files:
        candidate = model_path / name
        actual = candidate.resolve(strict=True)
        if candidate.is_symlink() or not actual.is_relative_to(model_path) or not actual.is_file():
            raise ValueError("SEMANTIC_MODEL_PATH_REJECTED")
        if actual.stat().st_size > (256 * 1024 * 1024 if name == "model.safetensors" else 4 * 1024 * 1024):
            raise ValueError("SEMANTIC_MODEL_SIZE_LIMIT")
        digest.update(name.encode("utf-8")); digest.update(b"\0")
        with actual.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    identity = "minilm-cpu-bert-mean-l2-v1-sha256:" + digest.hexdigest()
    if identity != arguments.identity:
        raise ValueError("SEMANTIC_MODEL_ID_CHANGED")
    configuration = json.loads((model_path / "config.json").read_text("utf-8"))
    pooling = json.loads((model_path / "1_Pooling/config.json").read_text("utf-8"))
    sentence_config = json.loads((model_path / "sentence_bert_config.json").read_text("utf-8"))
    expected = {"model_type": "bert", "hidden_size": 384, "num_hidden_layers": 6, "num_attention_heads": 12,
                "intermediate_size": 1536, "vocab_size": 30522, "max_position_embeddings": 512}
    if any(configuration.get(key) != value for key, value in expected.items()) or configuration.get("auto_map"):
        raise ValueError("SEMANTIC_MODEL_UNSUPPORTED")
    if not pooling.get("pooling_mode_mean_tokens") or any(pooling.get(name) for name in
            ("pooling_mode_cls_token", "pooling_mode_max_tokens", "pooling_mode_mean_sqrt_len_tokens")):
        raise ValueError("SEMANTIC_POOLING_UNSUPPORTED")
    max_tokens = min(256, int(sentence_config.get("max_seq_length", 256)))
    if max_tokens < 8:
        raise ValueError("SEMANTIC_MODEL_UNSUPPORTED")
    import torch
    from transformers import BertModel, BertTokenizerFast
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    tokenizer = BertTokenizerFast.from_pretrained(str(model_path), local_files_only=True)
    model = BertModel.from_pretrained(str(model_path), local_files_only=True, use_safetensors=True,
                                      attn_implementation="eager").to("cpu").eval()
    if any(parameter.device.type != "cpu" for parameter in model.parameters()) or torch.cuda.is_initialized():
        raise ValueError("SEMANTIC_LOCAL_CPU_ONLY")
    emit({"type": "ready", "id": identity, "dimensions": 384, "device": "cpu", "network": False,
          "maxTokens": max_tokens, "parameterDevice": "cpu", "torchCudaInitialized": False})
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line:
            return
        if len(line) > 65536 or not line.endswith(b"\n"):
            return
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("requestId")
            text = request.get("text")
            if type(request_id) is not int or not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > 12288:
                raise ValueError("SEMANTIC_INVALID_INPUT")
            inputs = tokenizer(text, return_tensors="pt", truncation=False, padding=False)
            if inputs["input_ids"].shape[1] > max_tokens:
                raise ValueError("SEMANTIC_INPUT_TOO_LONG")
            with torch.inference_mode():
                hidden = model(**inputs).last_hidden_state
                mask = inputs["attention_mask"].unsqueeze(-1).to(hidden.dtype)
                pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
                vector = torch.nn.functional.normalize(pooled, p=2, dim=1)[0].tolist()
            if len(vector) != 384 or not all(math.isfinite(number) for number in vector):
                raise ValueError("SEMANTIC_INFERENCE_FAILED")
            emit({"requestId": request_id, "id": identity, "vector": vector})
        except Exception as error:
            code = str(error) if str(error) in ("SEMANTIC_INPUT_TOO_LONG", "SEMANTIC_INVALID_INPUT") else "SEMANTIC_INFERENCE_FAILED"
            emit({"requestId": request_id, "error": code})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("SEMANTIC_WORKER_START_FAILED\n")
        raise SystemExit(1)
