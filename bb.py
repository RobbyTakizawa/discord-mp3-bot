import json
import yt_dlp
import os
import requests
import ffmpeg
import sys

TEMP_FILE = "web_cache"




def convert_with_library(input_file, output_file):
    (
        ffmpeg
        .input(input_file)
        .output(output_file, vn=None, audio_bitrate='128k')
        .run(overwrite_output=True)
    )

def download_raw_audio_stream(cdn_url, output_filename="cache_stream.webm"):
    print("Initiating direct stream connection...")
    
    # We use stream=True so we can download the file in small chunks
    # instead of pulling the entire file into RAM at once.
    with requests.get(cdn_url, stream=True) as response:
        # Check if the Google CDN accepted our security tokens/signature
        if response.status_code != 200:
            print(f"Download failed. HTTP Status: {response.status_code}")
            return False
            
        total_size = int(response.headers.get('content-length', 0))
        print(f"Connected! Total stream size: {total_size / (1024*1024):.2f} MB")
        
        # Open a local binary file to write the raw incoming data
        bytes_downloaded = 0
        with open(output_filename, 'wb') as f:
            # Read the stream in 256KB chunks
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if chunk: 
                    f.write(chunk)
                    bytes_downloaded += len(chunk)
                    # Simple progress indicator
                    print(f"Downloaded: {bytes_downloaded / total_size * 100:.1f}%", end="\r")
                    
    print(f"\nStep 3 Complete. Raw audio saved locally as: {output_filename}")
    return True

def extract_youtube_manifest(video_url):
    # Get the directory where bb.py is located
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # Create an absolute path to cookies.txt
    cookies_path = os.path.join(script_dir, 'cookies.txt')

    # Configure yt-dlp options
    ydl_opts = {
        'format': 'bestaudio/best',  # Focus on audio streams
        'cookiefile': cookies_path,   # <--- Updated to absolute path
        'js_runtimes': ['node'],
        'skip_download': True,        # Critical: tells yt-dlp not to download the actual media
        'quiet': True,                # Suppress standard terminal outputs
        'no_warnings': True,
    }
    
    print(f"Sending API requests for: {video_url}...")
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            # extract_info performs the handshake, cipher decryption, and API parsing
            info_dict = ydl.extract_info(video_url, download=False)
            return info_dict
        except Exception as e:
            print(f"Error extracting manifest: {e}")
            return None

if __name__ == "__main__":
    # Example video URL
    target_url = sys.argv[2]
    named = sys.argv[1]
    
    manifest = extract_youtube_manifest(target_url)
    
    if manifest:
        print("\n--- Step 1 Complete: Metadata Extracted ---")
        print(f"Title: {manifest.get('title')}")
        print(f"Uploader: {manifest.get('uploader')}")
        print(f"Duration: {manifest.get('duration')} seconds")
        
        # 'formats' contains the parsed CDN URLs for every separate video and audio stream
       # 'formats' contains the parsed CDN URLs for every separate video and audio stream
        formats = manifest.get('formats', [])

        # FIXED: Ensure vcodec is 'none' AND acodec is NOT 'none'
        audio_streams = [
            f for f in formats 
            if f.get('vcodec') == 'none' and f.get('acodec') != 'none'
        ]

        print(f"\nFound {len(audio_streams)} standalone audio stream manifests.")
        
        print(f"\nFound {len(audio_streams)} standalone audio stream manifests.")
        
        # Peek at the highest quality available audio stream configuration
        if audio_streams:
            best_audio = audio_streams[-1]
            print("\n--- Target Stream Located ---")
            print(f"Format ID: {best_audio.get('format_id')}")
            print(f"Audio Codec: {best_audio.get('acodec')}")
            print(f"Bitrate: {best_audio.get('abr')} kbps")
            ext = best_audio.get('ext')
            url = best_audio.get('url')
            temp_filen = TEMP_FILE + "." + ext
            download_raw_audio_stream(url, temp_filen)
            outfiln = "music/" + named + ".mp3"
            convert_with_library(temp_filen, outfiln)




