.PHONY: test lint contracts up

test:
	cd web && php artisan test
	cd web && npm test --silent
	cd engine && uv run pytest -q

lint:
	cd web && ./vendor/bin/pint --test
	cd engine && uv run ruff check . && uv run ruff format --check .

contracts:
	cd engine && uv run python -m scripts.export_contracts

up:
	docker compose up --build
