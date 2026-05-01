#!/usr/bin/env python3
"""
Test script for job scraper performance and debugging
"""

import os
import time
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv(override=True)

# Add the current directory to Python path so we can import job_scraper
sys.path.insert(0, str(Path(__file__).parent))

from job_scraper import search_all_platforms

def test_scraper():
    """Test the job scraper with past 24 hours and measure performance"""

    print("=" * 80)
    print("JOB SCRAPER PERFORMANCE TEST")
    print("=" * 80)

    # Test parameters
    title = "software engineer"
    location = "United States"
    date_posted = "past24Hours"  # Changed from pastWeek to past24Hours as requested

    print(f"Search Query: '{title}'")
    print(f"Location: '{location}'")
    print(f"Date Posted: '{date_posted}'")
    print()

    # Check environment variables
    print("ENVIRONMENT CHECK:")
    apify_token = os.environ.get("APIFY_API_TOKEN", "")
    if apify_token:
        print(f"✓ APIFY_API_TOKEN: {'*' * 20}{apify_token[-4:]}")
    else:
        print("✗ APIFY_API_TOKEN: NOT SET")

    adzuna_id = os.environ.get("ADZUNA_APP_ID", "")
    adzuna_key = os.environ.get("ADZUNA_APP_KEY", "")
    if adzuna_id and adzuna_key:
        print(f"✓ ADZUNA_APP_ID: {adzuna_id}")
        print(f"✓ ADZUNA_APP_KEY: {'*' * 20}{adzuna_key[-4:]}")
    else:
        print("✗ ADZUNA credentials: NOT SET")

    print()

    # Start timing
    start_time = time.time()

    try:
        # Run the search
        print("STARTING SCRAPE...")
        print("-" * 50)

        jobs = search_all_platforms(
            title=title,
            location=location,
            date_posted=date_posted
        )

        # End timing
        end_time = time.time()
        total_time = end_time - start_time

        print("-" * 50)
        print("SCRAPE COMPLETE")
        print("-" * 50)

        # Results summary
        print("\nRESULTS SUMMARY:")
        print(f"Total jobs found: {len(jobs)}")
        print(f"Total time: {total_time:.2f} seconds")
        print(f"Average time per job: {total_time/len(jobs):.2f} seconds" if jobs else "N/A")

        if jobs:
            # Group by source
            sources = {}
            for job in jobs:
                source = job.get('source', 'Unknown')
                sources[source] = sources.get(source, 0) + 1

            print("\nJobs by source:")
            for source, count in sorted(sources.items()):
                print(f"  {source}: {count}")

            # Show first few jobs as examples
            print("\nFIRST 5 JOBS:")
            for i, job in enumerate(jobs[:5]):
                print(f"{i+1}. [{job.get('source', 'Unknown')}] {job.get('title', 'No title')} at {job.get('company', 'Unknown')} - {job.get('location', 'Unknown')} ({job.get('posted', 'Unknown')})")

        else:
            print("❌ NO JOBS FOUND!")

        # Performance analysis
        print("\nPERFORMANCE ANALYSIS:")
        if total_time > 30:
            print(f"⚠️  SLOW: {total_time:.1f}s (>30s) - Users may get impatient")
        elif total_time > 15:
            print(f"🟡 MODERATE: {total_time:.1f}s (15-30s) - Acceptable but could be faster")
        else:
            print(f"✅ FAST: {total_time:.1f}s (<15s) - Good user experience")

        if len(jobs) == 0:
            print("❌ PROBLEM: No jobs found - check API keys and network")
        elif len(jobs) < 10:
            print("⚠️  LOW RESULTS: Only {} jobs found - may indicate API issues".format(len(jobs)))

        return True

    except Exception as e:
        end_time = time.time()
        total_time = end_time - start_time

        print("-" * 50)
        print("SCRAPE FAILED")
        print("-" * 50)
        print(f"Error after {total_time:.2f} seconds: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_scraper()
    sys.exit(0 if success else 1)