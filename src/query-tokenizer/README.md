# Pinned LFM query tokenizer

The tokenizer, configuration, chat template and license are unmodified files from
[LiquidAI/LFM2.5-230M-Base](https://huggingface.co/LiquidAI/LFM2.5-230M-Base/tree/9d2be5519834990d30996f878b6771cccbd24f2c),
revision `9d2be5519834990d30996f878b6771cccbd24f2c`. See [LICENSE](LICENSE) for
Liquid AI's terms and attribution. No model weights are included.

`contract.json` is our shared v2 student instruction and input/output limits.
Node uses `@huggingface/tokenizers@0.2.0`; Python uses the pinned training/runtime
Transformers tokenizer. Both load these files locally without Hub requests.
The model package must carry the same official assets and write the contract's
`system` instruction to `system.txt`; the worker rejects incompatible packages.

Official asset SHA-256:

| File | SHA-256 |
| --- | --- |
| tokenizer.json | df1d8d5ec5d091b460562ffd545e4a5e91d17d4a0db7ebe733be34ed374377bd |
| tokenizer_config.json | 75c287923e252b08b0a0f1c367bbe557ab23a681d0b71c5a34e0932ddbe2f5ee |
| chat_template.jinja | 6d65c8804847ad74eea912dd7eca3dc1cf7a457b53a77f47d841a14121910963 |
| LICENSE | 30adf9d6478191fb87f2424f63ba0728598335aaf99cd2848ef17e8e545fe94b |
