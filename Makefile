.PHONY: test lint contracts evidence up

test:
	cd web && php artisan test
	cd web && npm test --silent
	cd engine && uv run pytest -q

lint:
	cd web && ./vendor/bin/pint --test
	cd engine && uv run ruff check . && uv run ruff format --check .

contracts:
	cd engine && uv run python -m scripts.export_contracts

evidence:
	cd engine && uv run python -u -m scripts.ablation --volume 320 --seeds 3 --scenario all --time-limit 1.5
	cd engine && uv run python -u -m scripts.sensitivity

up:
	docker compose up --build

