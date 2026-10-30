"""Preview or import the versioned SKU catalog deliverables into an existing database.

Preview all brand workbooks:
    python scripts/import-sku-deliverables.py --database data/inventory.db

Apply missing models after reviewing the preview:
    python scripts/import-sku-deliverables.py --database data/inventory.db --apply

Only the `skus` table is written. Existing SKU rows and inventory records are preserved.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

from openpyxl import load_workbook


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DIRECTORY = PROJECT_DIR / "docs" / "sku-catalog" / "01-deliverables"
OPTION_COLUMNS = {
    "cpuOptions": "CPU选项",
    "ramOptions": "内存选项",
    "gpuOptions": "显卡选项",
    "storageOptions": "存储选项",
    "screenOptions": "屏幕选项",
}
MODEL_COLUMNS = (
    "型号唯一键", "产品类型", "品牌", "型号", "型号年份", "显示名", "分类",
    *OPTION_COLUMNS.values(), "来源链接", "来源标题", "置信度",
)
CONFIG_COLUMNS = (
    "组合编号", "型号唯一键", "显示名", "CPU", "内存", "显卡", "存储", "屏幕",
    "来源链接", "来源标题", "置信度",
)
ALIAS_COLUMNS = ("别名", "型号唯一键")
OPTION_TO_CONFIG = {
    "cpuOptions": "CPU", "ramOptions": "内存", "gpuOptions": "显卡",
    "storageOptions": "存储", "screenOptions": "屏幕",
}


@dataclass(frozen=True)
class Model:
    source_key: str
    product_type: str
    brand: str
    model: str
    year: int
    display_name: str
    confidence: str
    options: dict[str, list[str]]

    @property
    def key(self) -> tuple[str, str, str, int]:
        return (product_type_key(self.product_type), self.brand.casefold(), self.model.casefold(), self.year)

    @property
    def sku_id(self) -> str:
        digest = hashlib.sha256("\0".join(map(str, self.key)).encode("utf-8")).hexdigest()[:24]
        return f"sku_deliverable_{digest}"


def text(value: object) -> str:
    return " ".join(str(value or "").split())


def canonical_brand(value: str) -> str:
    return "小米" if value.strip().casefold() in {"redmi", "红米"} else value.strip()


def product_type_key(value: str) -> str:
    return "笔记本电脑" if value.strip() == "游戏本" else value.strip()


def parse_year(value: object, where: str) -> int:
    raw = text(value)
    if isinstance(value, bool) or not re.fullmatch(r"(?:19|20)\d{2}(?:\.0)?", raw):
        raise ValueError(f"{where}: invalid model year {value!r}")
    year = int(float(raw))
    if not 2016 <= year <= 2026:
        raise ValueError(f"{where}: model year is outside the delivered catalog range: {year}")
    return year


def validate_url(value: object, where: str) -> str:
    url = text(value)
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{where}: missing or invalid source URL")
    return url


def rows_by_header(workbook, sheet_name: str, required: tuple[str, ...]):
    if sheet_name not in workbook.sheetnames:
        raise ValueError(f"Missing worksheet: {sheet_name}")
    rows = workbook[sheet_name].iter_rows(values_only=True)
    headers = [text(value) for value in next(rows)]
    if len(headers) != len(set(headers)):
        raise ValueError(f"{sheet_name}: duplicate column heading")
    missing = set(required) - set(headers)
    if missing:
        raise ValueError(f"{sheet_name}: missing columns {sorted(missing)}")
    for row_number, row in enumerate(rows, 2):
        if any(value is not None and str(value).strip() for value in row):
            yield row_number, dict(zip(headers, row))


def parse_options(value: object, where: str) -> list[str]:
    try:
        parsed = json.loads(str(value or "[]"))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{where}: invalid JSON option array") from error
    if not isinstance(parsed, list) or any(not isinstance(item, str) or not item.strip() for item in parsed):
        raise ValueError(f"{where}: expected an array of nonempty strings")
    options = [text(item) for item in parsed]
    if len({item.casefold() for item in options}) != len(options):
        raise ValueError(f"{where}: repeated option")
    return options


def read_catalog(path: Path) -> tuple[list[Model], dict[str, int]]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        models: list[Model] = []
        by_source_key: dict[str, Model] = {}
        model_columns = ("型号唯一键", "产品类型", "品牌", "型号", "型号年份", "显示名", "分类",
                         *OPTION_COLUMNS.values(), "来源链接", "来源标题", "置信度")
        for row_number, row in rows_by_header(workbook, "SKU型号", model_columns):
            where = f"{path.name} SKU型号 row {row_number}"
            product_type = text(row["产品类型"])
            brand_source = text(row["品牌"])
            brand = canonical_brand(brand_source)
            model_name = text(row["型号"])
            year = parse_year(row["型号年份"], where)
            display_name = text(row["显示名"])
            if product_type != "笔记本电脑" or not brand or not model_name:
                raise ValueError(f"{where}: expected a named laptop model")
            if re.search(rf"(?:^|\s){year}(?:款)?$", model_name):
                raise ValueError(f"{where}: model repeats its separate year: {model_name}")
            category = text(row["分类"])
            if category not in {"轻薄本", "游戏本"}:
                raise ValueError(f"{where}: unexpected laptop category {category!r}")

            source_key = f"{product_type}|{brand_source}|{model_name}|{year}"
            if text(row["型号唯一键"]) != source_key:
                raise ValueError(f"{where}: model key does not match brand, model and year")
            expected_display = f"{brand_source} {model_name} {year}"
            if display_name != expected_display:
                raise ValueError(f"{where}: display name must be {expected_display!r}")
            confidence = text(row["置信度"]).lower()
            if confidence not in {"high", "medium"}:
                raise ValueError(f"{where}: low or missing confidence")
            validate_url(row["来源链接"], where)
            if not text(row["来源标题"]):
                raise ValueError(f"{where}: missing source title")

            options = {key: parse_options(row[column], f"{where} {column}")
                       for key, column in OPTION_COLUMNS.items()}
            if source_key in by_source_key:
                raise ValueError(f"{where}: duplicate model key {source_key}")
            item = Model(source_key, product_type, brand, model_name, year, display_name, confidence, options)
            models.append(item)
            by_source_key[source_key] = item

        config_ids: set[str] = set()
        low_confidence_configurations = 0
        configs_per_model: Counter[str] = Counter()
        for row_number, row in rows_by_header(workbook, "配置组合", CONFIG_COLUMNS):
            where = f"{path.name} 配置组合 row {row_number}"
            config_id = text(row["组合编号"])
            source_key = text(row["型号唯一键"])
            model = by_source_key.get(source_key)
            if not config_id or config_id in config_ids or model is None:
                raise ValueError(f"{where}: duplicate ID or unknown model key")
            if text(row["显示名"]) != model.display_name:
                raise ValueError(f"{where}: display name does not match its model")
            confidence = text(row["置信度"]).lower()
            if confidence not in {"high", "medium", "low"} or not text(row["来源标题"]):
                raise ValueError(f"{where}: missing source title or invalid confidence")
            if confidence == "low":
                low_confidence_configurations += 1
            validate_url(row["来源链接"], where)
            config_ids.add(config_id)
            configs_per_model[source_key] += 1

        alias_count = 0
        for row_number, row in rows_by_header(workbook, "别名", ALIAS_COLUMNS):
            where = f"{path.name} 别名 row {row_number}"
            if not text(row["别名"]) or text(row["型号唯一键"]) not in by_source_key:
                raise ValueError(f"{where}: empty alias or unknown model key")
            alias_count += 1

        empty_option_fields = [
            {"modelKey": model.source_key,
             "fields": [key for key, values in model.options.items() if not values]}
            for model in models if any(not values for values in model.options.values())
        ]
        return models, {
            "configurations": len(config_ids),
            "lowConfidenceConfigurations": low_confidence_configurations,
            "aliases": alias_count,
            "modelsWithoutConfigurations": len(set(by_source_key) - set(configs_per_model)),
            "modelsWithEmptyOptionFields": empty_option_fields,
        }
    finally:
        workbook.close()


def source_workbooks(directory: Path) -> list[Path]:
    by_brand: dict[str, list[tuple[datetime, Path]]] = {}
    for path in directory.glob("*/*/sku-catalog-*.xlsx"):
        brand = path.parent.parent.name
        try:
            batch_date = datetime.strptime(path.parent.name, "%Y-%m-%d")
        except ValueError as error:
            raise ValueError(f"Expected a YYYY-MM-DD batch directory: {path.parent}") from error
        by_brand.setdefault(brand, []).append((batch_date, path))

    selected = []
    for brand, batches in sorted(by_brand.items()):
        latest_date = max(batch_date for batch_date, _ in batches)
        latest_paths = sorted(path for batch_date, path in batches if batch_date == latest_date)
        if len(latest_paths) != 1:
            raise ValueError(f"Expected one catalog workbook for {brand} on {latest_date:%Y-%m-%d}")
        selected.extend(latest_paths)
    return selected


def load_models(directory: Path) -> tuple[list[Model], dict[str, dict[str, int]]]:
    paths = source_workbooks(directory)
    if not paths:
        raise ValueError(f"No sku-catalog-*.xlsx workbooks found under {directory}")
    all_models: list[Model] = []
    details: dict[str, dict[str, int]] = {}
    for path in paths:
        models, workbook_details = read_catalog(path)
        brand = path.parent.parent.name
        details[brand] = {"models": len(models), **workbook_details}
        all_models.extend(models)
    unique = {model.key for model in all_models}
    if len(unique) != len(all_models):
        raise ValueError("Duplicate productType/brand/model/year keys across deliverables")
    return all_models, details


def current_models(connection: sqlite3.Connection, include_deleted: bool = False) -> dict[tuple[str, str, str, int], sqlite3.Row]:
    condition = "" if include_deleted else "WHERE deleted = 0"
    rows = connection.execute(f"""
        SELECT id, productType, brand, model, year, cpuOptions, ramOptions,
               gpuOptions, storageOptions, screenOptions, deleted
        FROM skus {condition}
    """).fetchall()
    result = {}
    for row in rows:
        if row["year"] is None:
            continue
        key = (product_type_key(row["productType"]), canonical_brand(row["brand"]).casefold(),
               text(row["model"]).casefold(), int(row["year"]))
        if key in result and not row["deleted"] and not result[key]["deleted"]:
            raise ValueError(f"Database already has duplicate active SKU keys: {key}")
        if key not in result or (result[key]["deleted"] and not row["deleted"]):
            result[key] = row
    return result


def option_differences(previous: sqlite3.Row, incoming: Model) -> list[str]:
    changed = []
    for key, values in incoming.options.items():
        existing = json.loads(previous[key] or "[]")
        if existing != values:
            changed.append(key)
    return changed


def preview(connection: sqlite3.Connection, models: list[Model], details: dict[str, dict[str, int]]) -> dict:
    existing = current_models(connection)
    including_deleted = current_models(connection, include_deleted=True)
    new = [model for model in models if model.key not in existing and model.key not in including_deleted]
    deleted_matches = [model.source_key for model in models
                       if model.key not in existing and model.key in including_deleted]
    differing = []
    for model in models:
        previous = existing.get(model.key)
        if previous:
            changes = option_differences(previous, model)
            if changes:
                differing.append({"modelKey": model.source_key, "fields": changes})
    return {
        "sourceModels": len(models),
        "sourceByBrand": dict(Counter(model.brand for model in models)),
        "sourceWorkbooks": details,
        "newModels": len(new),
        "newByBrand": dict(Counter(model.brand for model in new)),
        "existingModels": len(models) - len(new) - len(deleted_matches),
        "logicallyDeletedMatches": deleted_matches,
        "existingWithDifferentOptions": differing,
        "newModelKeySample": [model.source_key for model in new[:12]],
    }


def backup_database(connection: sqlite3.Connection, path: Path) -> Path:
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = backup_dir / f"{path.stem}.before-sku-deliverables-{timestamp}.db"
    destination = sqlite3.connect(backup)
    try:
        connection.backup(destination)
        result = destination.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise ValueError(f"Backup integrity_check failed: {result}")
    finally:
        destination.close()
    return backup


def apply(connection: sqlite3.Connection, path: Path, models: list[Model],
          details: dict[str, dict[str, int]]) -> dict:
    before = preview(connection, models, details)
    if before["logicallyDeletedMatches"]:
        raise ValueError("Some catalog models match logically deleted SKUs; review these records before importing")
    if not before["newModels"]:
        return {"mode": "unchanged", **before}

    backup = backup_database(connection, path)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        connection.execute("BEGIN IMMEDIATE")
        existing = current_models(connection)
        actor = connection.execute("""
            SELECT id FROM users WHERE role = 'admin' AND status = 'active'
            ORDER BY createdAt, id LIMIT 1
        """).fetchone()
        if actor is None:
            actor = connection.execute("SELECT id FROM users ORDER BY createdAt, id LIMIT 1").fetchone()
        if not actor:
            raise ValueError("No user exists for SKU createdBy")

        inserted = 0
        insert = connection.execute
        for model in models:
            if model.key in existing:
                continue
            insert("""
                INSERT INTO skus (
                  id, productType, brand, model, year,
                  cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions,
                  priceMin, priceMax, deleted, createdBy, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)
            """, (
                model.sku_id, product_type_key(model.product_type), model.brand, model.model, model.year,
                *[json.dumps(model.options[key], ensure_ascii=False) for key in OPTION_COLUMNS],
                actor["id"], now, now,
            ))
            existing[model.key] = None
            inserted += 1
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Post-import integrity_check failed: {integrity}")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    final_count = connection.execute("SELECT COUNT(*) FROM skus WHERE deleted = 0").fetchone()[0]
    return {"mode": "applied", "inserted": inserted, "backup": str(backup),
            "integrity": integrity, "activeSkus": final_count,
            **preview(connection, models, details)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY,
                        help="Deliverables directory; all brand workbooks below it are validated")
    parser.add_argument("--database", type=Path, required=True,
                        help="Existing SQLite database; required even for preview")
    parser.add_argument("--apply", action="store_true", help="Back up, then insert missing SKU models")
    args = parser.parse_args()
    directory = args.directory.resolve()
    database = args.database.resolve()
    if not directory.is_dir():
        parser.error(f"Deliverables directory does not exist: {directory}")
    if not database.is_file():
        parser.error(f"Database does not exist: {database}")
    models, details = load_models(directory)
    database_uri = f"file:{quote(database.as_posix(), safe='/:')}?mode={'rw' if args.apply else 'ro'}"
    connection = sqlite3.connect(database_uri, timeout=30, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    try:
        before = preview(connection, models, details)
        print(json.dumps({"mode": "preview", "database": str(database), **before},
                         ensure_ascii=False, indent=2))
        if args.apply:
            print(json.dumps(apply(connection, database, models, details),
                             ensure_ascii=False, indent=2))
    finally:
        connection.close()


if __name__ == "__main__":
    main()

