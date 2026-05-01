"""
routes/jobs.py — Job search Blueprint for JobPilot Flask app.
"""
import logging

from flask import Blueprint, request, jsonify, current_app

from core.job_scraper import search_all_platforms, fetch_job_description

jobs_bp = Blueprint("jobs", __name__)
logger = logging.getLogger("jobpilot")


@jobs_bp.post("/api/jobs")
def search_jobs():
    data = request.get_json(silent=True) or {}
    title = data.get("title", "").strip()
    if not title:
        return jsonify({"detail": "Job title is required"}), 400
    location = (data.get("location", "") or "United States").strip()
    seniority = data.get("seniority", "any") or "any"
    date_posted = data.get("date_posted", "pastWeek") or "pastWeek"

    _usage = current_app.config["USAGE"]
    _usage["total_searches"]   += 1
    _usage["jsearch_requests"] += 5
    _usage["adzuna_requests"]  += 4

    logger.info(f"SEARCH | title='{title}' location='{location}' seniority='{seniority}'")
    try:
        jobs = search_all_platforms(title, location, seniority, date_posted)
    except Exception as e:
        logger.error(f"SEARCH ERROR | {e}", exc_info=True)
        return jsonify({"detail": str(e)}), 500
    sources = list({j["source"] for j in jobs})
    logger.info(f"SEARCH DONE | {len(jobs)} jobs from {sources}")
    return jsonify({"jobs": jobs, "count": len(jobs), "sources": sources,
                    "title": title, "location": location})


@jobs_bp.post("/api/jd")
def get_jd():
    data = request.get_json(silent=True) or {}
    jd = data.get("description", "")
    url = data.get("url", "")
    if not jd and url:
        logger.info(f"JD FETCH | url={url[:80]}")
        jd = fetch_job_description(url)
        logger.info(f"JD FETCH DONE | chars={len(jd)}")
    return jsonify({"description": jd})
